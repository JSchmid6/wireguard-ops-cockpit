#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/lib/nextcloud-maintenance-common.sh"

is_allowed_root_entry() {
  case "$1" in
    .htaccess|.user.ini|3rdparty|apps|AUTHORS|config|console.php|COPYING|core|cron.php|custom_apps|dist|index.html|index.php|lib|occ|ocm-provider|ocs|ocs-provider|public.php|README|remote.php|resources|robots.txt|SECURITY.md|status.php|themes|updater|version.php)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

assert_safe_archive_entries() {
  local archive_path=$1
  local entry
  while IFS= read -r entry; do
    entry=${entry#./}
    [[ -z "$entry" ]] && continue
    case "$entry" in
      /*|../*|*/../*|..)
        echo "Unsafe archive entry detected: $entry"
        exit 1
        ;;
      data|data/*)
        echo "Rollback app archive must not contain the Nextcloud data directory."
        exit 1
        ;;
    esac
  done < <(tar -tf "$archive_path")
}

restore_app_root_from_archive() {
  local archive_path=$1
  local staging_dir
  staging_dir=$(mktemp -d)
  trap 'rm -rf "$staging_dir"' RETURN

  assert_safe_archive_entries "$archive_path"
  tar -xzf "$archive_path" -C "$staging_dir"

  local invalid_node
  invalid_node=$(find "$staging_dir" \( -type l -o -type b -o -type c -o -type p -o -type s \) -print -quit || true)
  if [[ -n "$invalid_node" ]]; then
    echo "Rollback archive contained an unsupported filesystem node: $invalid_node"
    exit 1
  fi
  invalid_node=$(find "$staging_dir" -type f -links +1 -print -quit || true)
  if [[ -n "$invalid_node" ]]; then
    echo "Rollback archive contained a hardlinked file: $invalid_node"
    exit 1
  fi

  local extracted_root=$staging_dir
  local root_children=("$staging_dir"/*)
  if [[ ${#root_children[@]} -eq 1 && -d "${root_children[0]}" ]]; then
    extracted_root=${root_children[0]}
  fi
  if [[ ! -f "$extracted_root/version.php" || ! -f "$extracted_root/occ" ]]; then
    echo "Rollback archive did not unpack into a recognizable Nextcloud root."
    exit 1
  fi

  shopt -s dotglob nullglob
  local item
  local entry_name
  for item in "$extracted_root"/*; do
    entry_name=$(basename "$item")
    if ! is_allowed_root_entry "$entry_name"; then
      echo "Rollback archive contains an unexpected root entry: $entry_name"
      exit 1
    fi
  done

  for item in "$extracted_root"/*; do
    entry_name=$(basename "$item")
    rm -rf --one-file-system "$NEXTCLOUD_ROOT/$entry_name"
    cp -a "$item" "$NEXTCLOUD_ROOT/$entry_name"
  done
  shopt -u dotglob nullglob
}

stream_dump_to_stdout() {
  local dump_path=$1
  case "$dump_path" in
    *.gz)
      gzip -dc "$dump_path"
      ;;
    *)
      cat "$dump_path"
      ;;
  esac
}

restore_sqlite_database() {
  local database_name
  database_name=$(nextcloud_config_value dbname)
  local data_directory
  data_directory=$(nextcloud_config_value datadirectory)
  local target_path
  if [[ "$database_name" == /* ]]; then
    target_path=$database_name
  else
    target_path=$data_directory/$database_name
  fi

  mkdir -p "$(dirname -- "$target_path")"
  if [[ "$ROLLBACK_DB_DUMP_PATH" == *.sql || "$ROLLBACK_DB_DUMP_PATH" == *.sql.gz ]]; then
    command -v sqlite3 >/dev/null 2>&1 || {
      echo "sqlite3 client not found for rollback restore."
      exit 1
    }
    rm -f "$target_path"
    sqlite3 "$target_path" < <(stream_dump_to_stdout "$ROLLBACK_DB_DUMP_PATH")
  else
    case "$ROLLBACK_DB_DUMP_PATH" in
      *.gz)
        gzip -dc "$ROLLBACK_DB_DUMP_PATH" > "$target_path"
        ;;
      *)
        cat "$ROLLBACK_DB_DUMP_PATH" > "$target_path"
        ;;
    esac
  fi
}

restore_mysql_database() {
  local database_name
  database_name=$(nextcloud_config_value dbname)
  local database_user
  database_user=$(nextcloud_config_value dbuser)
  local database_password
  database_password=$(nextcloud_config_value dbpassword)
  local database_host
  database_host=$(nextcloud_config_value dbhost)
  local database_port
  database_port=$(nextcloud_config_value dbport 2>/dev/null || true)
  local mysql_executable
  mysql_executable=$(command -v mysql || command -v mariadb || true)
  if [[ -z "$mysql_executable" ]]; then
    echo "MySQL client not found for rollback restore."
    exit 1
  fi

  local mysql_args=(--user="$database_user" --database="$database_name")
  if [[ "$database_host" == /* ]]; then
    mysql_args+=(--socket="$database_host")
  elif [[ "$database_host" == *:* ]]; then
    local host_part=${database_host%%:*}
    local host_suffix=${database_host#*:}
    if [[ "$host_suffix" == /* ]]; then
      mysql_args+=(--host="$host_part" --socket="$host_suffix")
    else
      mysql_args+=(--host="$host_part" --port="$host_suffix")
    fi
  elif [[ -n "$database_host" ]]; then
    mysql_args+=(--host="$database_host")
  fi
  if [[ -n "$database_port" ]]; then
    mysql_args+=(--port="$database_port")
  fi

  MYSQL_PWD="$database_password" stream_dump_to_stdout "$ROLLBACK_DB_DUMP_PATH" | "$mysql_executable" "${mysql_args[@]}"
}

restore_pgsql_database() {
  local database_name
  database_name=$(nextcloud_config_value dbname)
  local database_user
  database_user=$(nextcloud_config_value dbuser)
  local database_password
  database_password=$(nextcloud_config_value dbpassword)
  local database_host
  database_host=$(nextcloud_config_value dbhost 2>/dev/null || true)
  local database_port
  database_port=$(nextcloud_config_value dbport 2>/dev/null || true)
  command -v psql >/dev/null 2>&1 || {
    echo "psql client not found for rollback restore."
    exit 1
  }

  local psql_args=(--username="$database_user" --dbname="$database_name" --set ON_ERROR_STOP=1)
  if [[ -n "$database_host" ]]; then
    psql_args+=(--host="$database_host")
  fi
  if [[ -n "$database_port" ]]; then
    psql_args+=(--port="$database_port")
  fi

  PGPASSWORD="$database_password" stream_dump_to_stdout "$ROLLBACK_DB_DUMP_PATH" | psql "${psql_args[@]}"
}

restore_database_from_manifest() {
  case "$ROLLBACK_DB_TYPE" in
    mysql|mysqli)
      restore_mysql_database
      ;;
    pgsql)
      restore_pgsql_database
      ;;
    sqlite|sqlite3)
      restore_sqlite_database
      ;;
  esac
}

lock_nextcloud_maintenance_flow
ensure_nextcloud_root
require_nextcloud_phase "maintenance-enabled" "upgrade-complete" "maintenance-disabled" "verification-complete"
load_rollback_manifest

print_nextcloud_header "Nextcloud rollback restore"

echo "-- Approved rollback manifest --"
echo "Manifest: $ROLLBACK_MANIFEST_PATH"
echo "Manifest digest: $ROLLBACK_MANIFEST_DIGEST"
echo "Backup id: $ROLLBACK_BACKUP_ID"
echo "Created at: $ROLLBACK_CREATED_AT"
echo "Expected version: $ROLLBACK_EXPECTED_VERSION"
echo "Database engine: $ROLLBACK_DB_TYPE"
echo "Restore scope: app-root, database"
echo

ensure_maintenance_mode_on

echo "-- Restore Nextcloud app root --"
restore_app_root_from_archive "$ROLLBACK_APP_ARCHIVE_PATH"
echo "Restored archive: $ROLLBACK_APP_ARCHIVE_PATH"
echo "Archive digest: $ROLLBACK_APP_ARCHIVE_DIGEST"
echo

echo "-- Restore database --"
restore_database_from_manifest
echo "Restored database artifact: $ROLLBACK_DB_DUMP_PATH"
echo "Database artifact digest: $ROLLBACK_DB_DUMP_DIGEST"
echo

echo "-- Restored version --"
nextcloud_version_string
echo

write_rollback_state
set_nextcloud_phase "rollback-restored"

echo "-- Stored rollback state --"
cat "$NEXTCLOUD_ROLLBACK_STATE_FILE"
echo
echo "-- Stored maintenance phase --"
echo "rollback-restored"