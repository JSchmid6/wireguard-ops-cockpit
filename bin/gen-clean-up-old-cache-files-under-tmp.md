# Clean up old cache files under tmp
> Generated 2026-07-12T10:05:04.451Z

## Prompt
Clean up old cache files under /tmp/

## Planner Output
```
Y-%m-%d %H:%M:%S')" "
$*" >> "${LOG_FILE}"
}
DIR_CHECK() {
    if [[ ! -d "${TMP_DIR}" ]]; then
        log "ERROR: ${TMP_DIR} is not a directory. Aborting."
        exit 1
    fi
    if [[ ! -w "${TMP_DIR}" ]]; then
        log "ERROR: ${TMP_DIR} is not writable. Aborting."
        exit 1
    fi
}
RECOVER_STALE() {
    local stale
    stale=$(/usr/bin/find "${TMP_DIR}" -maxdepth 1 -name '.tmp-cleanup-*'
 -mmin +30 2>/dev/null || true)
    if [[ -n "${stale}" ]]; then
        log "INFO: Found stale marker file(s), removing."
        /usr/bin/rm -f ${stale} 2>/dev/null || true
    fi
}
CLEANUP() {
    local deletion_errors
    local files_to_delete
    files_to_delete=$(/usr/bin/find "${TMP_DIR}" -ignore_readdir_race -ma
xdepth 1 -type f -mtime "+${CUTOFF_DAYS}" -printf '%p\n' 2>/dev/null || t
rue)
    if [[ -z "${files_to_delete}" ]]; then
        log "INFO: No files older than ${CUTOFF_DAYS} days found in ${TMP
_DIR}."
        return 0
    fi
    DELETED_COUNT=$(/usr/bin/printf '%s\n' "${files_to_delete}" | /usr/bi
n/wc -l)
    DELETED_COUNT=$((DELETED_COUNT))
    while IFS= read -r f; do
        if [[ -n "${f}" ]]; then
            if /usr/bin/rm -f "${f}" 2>/dev/null; then
                :
            else
                log "WARN: Failed to delete '${f}'."
                ERROR_COUNT=$((ERROR_COUNT + 1))
            fi
        fi
    done <<< "${files_to_delete}"
    DELETED_COUNT=$((DELETED_COUNT - ERROR_COUNT))
}
MAIN() {
    log "START: /tmp cleanup (cutoff: ${CUTOFF_DAYS} days)"
    DIR_CHECK
    RECOVER_STALE
    SIZE_BEFORE=$(MEASURE_SIZE || echo "0")
    CLEANUP || true
    SIZE_AFTER=$(MEASURE_SIZE || echo "0")
    local freed=$((SIZE_BEFORE - SIZE_AFTER))
    if [[ "${freed}" -lt 0 ]]; then
        freed=0
    fi
    local freed_h
    freed_h=$(/usr/bin/numfmt --to=iec --suffix=B "${freed}" 2>/dev/null
|| /usr/bin/printf '%d bytes' "${freed}")
    log "END: Deleted ${DELETED_COUNT} files, freed ${freed_h}, ${ERROR_C
OUNT} errors"
    exit 0
}
MAIN
'''
```