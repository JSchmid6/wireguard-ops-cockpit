#!/usr/bin/env bash
set -euo pipefail

NEXTCLOUD_ROOT=${NEXTCLOUD_ROOT:-/var/www/nextcloud}
PHP_BIN=${PHP_BIN:-/usr/bin/php}
RUNTIME_DIR=${RUNTIME_DIR:-/run/wireguard-ops-cockpit}
NEXTCLOUD_BACKUP_ROOT=${NEXTCLOUD_BACKUP_ROOT:-/var/backups/wireguard-ops-cockpit/nextcloud}
NEXTCLOUD_APPROVED_ROLLBACK_MANIFEST=${NEXTCLOUD_APPROVED_ROLLBACK_MANIFEST:-approved-rollback/manifest.json}
NEXTCLOUD_ROLLBACK_MANIFEST_SCHEMA=${NEXTCLOUD_ROLLBACK_MANIFEST_SCHEMA:-nextcloud-rollback-manifest/v1}
NEXTCLOUD_FLOW_LOCK_FILE=$RUNTIME_DIR/nextcloud-maintenance.lock
NEXTCLOUD_FLOW_STATE_FILE=$RUNTIME_DIR/nextcloud-maintenance.state
NEXTCLOUD_ROLLBACK_STATE_FILE=$RUNTIME_DIR/nextcloud-rollback.state

ensure_runtime_dir() {
  mkdir -p "$RUNTIME_DIR"
}

lock_nextcloud_maintenance_flow() {
  ensure_runtime_dir
  exec 9>"$NEXTCLOUD_FLOW_LOCK_FILE"
  flock -n 9 || {
    echo "Another Nextcloud maintenance helper is already active."
    exit 1
  }
}

ensure_nextcloud_root() {
  if [[ ! -d "$NEXTCLOUD_ROOT" ]]; then
    echo "Nextcloud root not found at $NEXTCLOUD_ROOT"
    exit 1
  fi
}

current_nextcloud_phase() {
  if [[ -f "$NEXTCLOUD_FLOW_STATE_FILE" ]]; then
    tr -d '\n' < "$NEXTCLOUD_FLOW_STATE_FILE"
    return 0
  fi

  printf 'idle'
}

set_nextcloud_phase() {
  printf '%s\n' "$1" > "$NEXTCLOUD_FLOW_STATE_FILE"
}

clear_rollback_state() {
  rm -f "$NEXTCLOUD_ROLLBACK_STATE_FILE"
}

require_nextcloud_phase() {
  local current_phase
  current_phase=$(current_nextcloud_phase)
  local allowed_phase
  for allowed_phase in "$@"; do
    if [[ "$current_phase" == "$allowed_phase" ]]; then
      return 0
    fi
  done

  echo "Nextcloud maintenance phase mismatch."
  echo "Expected one of: $*"
  echo "Current phase: $current_phase"
  exit 1
}

print_nextcloud_header() {
  echo "== $1 =="
  echo "Timestamp: $(date --iso-8601=seconds)"
  echo "Host: $(hostname -f 2>/dev/null || hostname)"
  echo "Root: $NEXTCLOUD_ROOT"
  echo "Current phase: $(current_nextcloud_phase)"
  echo
}

run_occ() {
  runuser -u www-data -- "$PHP_BIN" "$NEXTCLOUD_ROOT/occ" "$@"
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

verify_sha256() {
  local file_path=$1
  local expected_digest=$2
  local label=$3
  local actual_digest
  actual_digest=$(sha256_file "$file_path")

  if [[ "$actual_digest" != "$expected_digest" ]]; then
    echo "$label digest mismatch."
    echo "Expected: $expected_digest"
    echo "Actual:   $actual_digest"
    exit 1
  fi
}

resolve_backup_relative_file() {
  local relative_path=$1
  if [[ -z "$relative_path" ]]; then
    echo "Rollback manifest entry is empty."
    exit 1
  fi
  if [[ "$relative_path" == /* ]]; then
    echo "Rollback manifest paths must stay relative to the bounded backup root."
    exit 1
  fi

  local backup_root
  backup_root=$(realpath -e -- "$NEXTCLOUD_BACKUP_ROOT")
  local candidate=$NEXTCLOUD_BACKUP_ROOT/$relative_path
  if [[ ! -e "$candidate" ]]; then
    echo "Rollback artifact not found at $candidate"
    exit 1
  fi
  if [[ -L "$candidate" ]]; then
    echo "Rollback artifact must not be a symlink: $candidate"
    exit 1
  fi

  local resolved
  resolved=$(realpath -e -- "$candidate")
  case "$resolved" in
    "$backup_root"|"$backup_root"/*)
      ;;
    *)
      echo "Rollback artifact escaped the bounded backup root."
      exit 1
      ;;
  esac

  printf '%s\n' "$resolved"
}

require_regular_file() {
  local file_path=$1
  local label=$2
  if [[ ! -f "$file_path" || -L "$file_path" ]]; then
    echo "$label must be a regular file: $file_path"
    exit 1
  fi
  if [[ "$(stat -c '%F' "$file_path")" != "regular file" ]]; then
    echo "$label must be a regular file: $file_path"
    exit 1
  fi
  if [[ "$(stat -c '%h' "$file_path")" != "1" ]]; then
    echo "$label must not be hardlinked: $file_path"
    exit 1
  fi
}

manifest_scalar_value() {
  local manifest_path=$1
  local key=$2
  "$PHP_BIN" -r '
    $manifestPath = $argv[1];
    $key = $argv[2];
    $raw = file_get_contents($manifestPath);
    if ($raw === false) {
      fwrite(STDERR, "Unable to read rollback manifest.\n");
      exit(1);
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
      fwrite(STDERR, "Rollback manifest is not valid JSON.\n");
      exit(1);
    }
    if (!array_key_exists($key, $data)) {
      fwrite(STDERR, "Rollback manifest key missing: {$key}\n");
      exit(1);
    }
    $value = $data[$key];
    if (is_array($value) || is_object($value) || $value === null) {
      fwrite(STDERR, "Rollback manifest key must be scalar: {$key}\n");
      exit(1);
    }
    if (is_bool($value)) {
      echo $value ? "true" : "false";
      exit(0);
    }
    echo (string) $value;
  ' "$manifest_path" "$key"
}

manifest_array_contains() {
  local manifest_path=$1
  local key=$2
  local expected_value=$3
  "$PHP_BIN" -r '
    $manifestPath = $argv[1];
    $key = $argv[2];
    $expected = $argv[3];
    $raw = file_get_contents($manifestPath);
    if ($raw === false) {
      exit(1);
    }
    $data = json_decode($raw, true);
    if (!is_array($data) || !array_key_exists($key, $data) || !is_array($data[$key])) {
      exit(1);
    }
    foreach ($data[$key] as $item) {
      if ((string) $item === $expected) {
        exit(0);
      }
    }
    exit(1);
  ' "$manifest_path" "$key" "$expected_value"
}

load_rollback_manifest() {
  ROLLBACK_MANIFEST_PATH=$(resolve_backup_relative_file "$NEXTCLOUD_APPROVED_ROLLBACK_MANIFEST")
  require_regular_file "$ROLLBACK_MANIFEST_PATH" "Rollback manifest"
  ROLLBACK_MANIFEST_DIGEST=$(sha256_file "$ROLLBACK_MANIFEST_PATH")
  ROLLBACK_SCHEMA_VERSION=$(manifest_scalar_value "$ROLLBACK_MANIFEST_PATH" "schemaVersion")
  if [[ "$ROLLBACK_SCHEMA_VERSION" != "$NEXTCLOUD_ROLLBACK_MANIFEST_SCHEMA" ]]; then
    echo "Unsupported rollback manifest schema: $ROLLBACK_SCHEMA_VERSION"
    exit 1
  fi

  ROLLBACK_BACKUP_ID=$(manifest_scalar_value "$ROLLBACK_MANIFEST_PATH" "backupId")
  ROLLBACK_CREATED_AT=$(manifest_scalar_value "$ROLLBACK_MANIFEST_PATH" "createdAt")
  ROLLBACK_EXPECTED_VERSION=$(manifest_scalar_value "$ROLLBACK_MANIFEST_PATH" "expectedVersion")
  ROLLBACK_TARGET_ROOT=$(manifest_scalar_value "$ROLLBACK_MANIFEST_PATH" "targetRoot")
  ROLLBACK_DB_TYPE=$(manifest_scalar_value "$ROLLBACK_MANIFEST_PATH" "dbType")
  ROLLBACK_MAINTENANCE_REQUIRED=$(manifest_scalar_value "$ROLLBACK_MANIFEST_PATH" "maintenanceModeRequired")
  if [[ "$ROLLBACK_TARGET_ROOT" != "$NEXTCLOUD_ROOT" ]]; then
    echo "Rollback manifest target root mismatch."
    echo "Expected: $NEXTCLOUD_ROOT"
    echo "Actual:   $ROLLBACK_TARGET_ROOT"
    exit 1
  fi
  if [[ "$ROLLBACK_MAINTENANCE_REQUIRED" != "true" ]]; then
    echo "Rollback manifest must require maintenance mode."
    exit 1
  fi
  if ! manifest_array_contains "$ROLLBACK_MANIFEST_PATH" "restoreScope" "app-root"; then
    echo "Rollback manifest restoreScope must include app-root."
    exit 1
  fi
  if ! manifest_array_contains "$ROLLBACK_MANIFEST_PATH" "restoreScope" "database"; then
    echo "Rollback manifest restoreScope must include database."
    exit 1
  fi

  case "$ROLLBACK_DB_TYPE" in
    mysql|mysqli|pgsql|sqlite|sqlite3)
      ;;
    *)
      echo "Unsupported rollback manifest dbType: $ROLLBACK_DB_TYPE"
      exit 1
      ;;
  esac

  ROLLBACK_APP_ARCHIVE_PATH=$(resolve_backup_relative_file "$(manifest_scalar_value "$ROLLBACK_MANIFEST_PATH" "appArchivePath")")
  require_regular_file "$ROLLBACK_APP_ARCHIVE_PATH" "Rollback app archive"
  ROLLBACK_APP_ARCHIVE_DIGEST=$(manifest_scalar_value "$ROLLBACK_MANIFEST_PATH" "appArchiveSha256")
  verify_sha256 "$ROLLBACK_APP_ARCHIVE_PATH" "$ROLLBACK_APP_ARCHIVE_DIGEST" "Rollback app archive"

  ROLLBACK_DB_DUMP_PATH=$(resolve_backup_relative_file "$(manifest_scalar_value "$ROLLBACK_MANIFEST_PATH" "dbDumpPath")")
  require_regular_file "$ROLLBACK_DB_DUMP_PATH" "Rollback database artifact"
  ROLLBACK_DB_DUMP_DIGEST=$(manifest_scalar_value "$ROLLBACK_MANIFEST_PATH" "dbDumpSha256")
  verify_sha256 "$ROLLBACK_DB_DUMP_PATH" "$ROLLBACK_DB_DUMP_DIGEST" "Rollback database artifact"
}

maintenance_mode_value() {
  local value
  value=$(run_occ config:system:get maintenance 2>/dev/null || true)
  printf '%s\n' "$value" | tr -d '\r\n' | tr '[:upper:]' '[:lower:]'
}

ensure_maintenance_mode_on() {
  local current_value
  current_value=$(maintenance_mode_value)
  if [[ "$current_value" != "true" && "$current_value" != "1" ]]; then
    run_occ maintenance:mode --on
  fi
}

require_maintenance_mode_on() {
  local current_value
  current_value=$(maintenance_mode_value)
  if [[ "$current_value" != "true" && "$current_value" != "1" ]]; then
    echo "Maintenance mode must stay enabled for this helper."
    exit 1
  fi
}

nextcloud_config_value() {
  local config_key=$1
  "$PHP_BIN" -r '
    $configPath = $argv[1];
    $configKey = $argv[2];
    $CONFIG = [];
    include $configPath;
    if (!array_key_exists($configKey, $CONFIG) || is_array($CONFIG[$configKey]) || is_object($CONFIG[$configKey]) || $CONFIG[$configKey] === null) {
      exit(1);
    }
    if (is_bool($CONFIG[$configKey])) {
      echo $CONFIG[$configKey] ? "true" : "false";
      exit(0);
    }
    echo (string) $CONFIG[$configKey];
  ' "$NEXTCLOUD_ROOT/config/config.php" "$config_key"
}

nextcloud_version_string() {
  "$PHP_BIN" -r '
    $versionPath = $argv[1];
    include $versionPath;
    if (!isset($OC_VersionString)) {
      exit(1);
    }
    echo (string) $OC_VersionString;
  ' "$NEXTCLOUD_ROOT/version.php"
}

write_rollback_state() {
  cat > "$NEXTCLOUD_ROLLBACK_STATE_FILE" <<EOF
MANIFEST_DIGEST=$ROLLBACK_MANIFEST_DIGEST
BACKUP_ID=$ROLLBACK_BACKUP_ID
EXPECTED_VERSION=$ROLLBACK_EXPECTED_VERSION
APP_ARCHIVE_DIGEST=$ROLLBACK_APP_ARCHIVE_DIGEST
DB_DUMP_DIGEST=$ROLLBACK_DB_DUMP_DIGEST
RESTORED_AT=$(date --iso-8601=seconds)
EOF
}

read_rollback_state_value() {
  local key=$1
  if [[ ! -f "$NEXTCLOUD_ROLLBACK_STATE_FILE" ]]; then
    echo "Rollback state file is missing."
    exit 1
  fi

  awk -F '=' -v key="$key" '$1 == key { print $2 }' "$NEXTCLOUD_ROLLBACK_STATE_FILE"
}