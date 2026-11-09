import { describe, expect, it } from "vitest";

import { backupGuardFocus, backupGuardHits } from "../../../deploy/helpers/cockpit-backup-guard.mjs";

// Rolle box (Proxmox-Host, Karte t_5f5c89fe, Befund N2 aus t_88f1e802): vzdump-
// Sicherungen löschen oder ihre Aufbewahrung kürzen, Gast-Snapshots löschen oder
// zurückrollen und Gäste zerstören braucht Jochens Freigabe — wie borg delete
// (G10). Der Riegel ist rollenunabhängig; auf VPS und Lab0 gibt es die Werkzeuge
// nicht. Die Rotation von cockpit-host-snapshot läuft im Helfer selbst (nicht als
// Plantext) und bleibt frei.

const hits = (run: string, check?: string) => backupGuardHits({ steps: [{ run }], checks: check ? [{ run: check }] : [] });
const focus = (run: string) => backupGuardFocus({ steps: [{ run }], checks: [] });

// Lesen, neue Sicherungen, neue Snapshots, Gäste bedienen: frei.
const free: Array<[string, string]> = [
  ["guest snapshots listed", "qm listsnapshot 100\npct listsnapshot 101\n/usr/sbin/qm listsnapshot 100"],
  ["storage listed", "pvesm status\npvesm list local --content backup\npvesm path local:backup/vzdump-qemu-100-2026_11_09-02_00_00.vma.zst"],
  ["vzdump without --remove", "vzdump 100 --storage local --mode snapshot --compress zstd"],
  ["vzdump with --remove 0", "vzdump 100 --storage local --remove 0"],
  ["prune dry run", "pvesm prune-backups local --dry-run 1 --vmid 100\npvesm prune-backups local --dry-run"],
  ["API reads", "pvesh get /nodes/box/qemu/100/snapshot\npvesh get /nodes/box/storage/local/content --content backup\npvesh get /cluster/backup"],
  ["a new backup job", "pvesh create /cluster/backup --schedule '02:00' --storage lab0 --vmid 100,101 --mode snapshot"],
  ["a new snapshot", "qm snapshot 100 vor-update --description 'vor dem Update'\npct snapshot 101 vor-update"],
  ["guest routine", "qm start 100\nqm shutdown 100 --timeout 120\npct reboot 101\nqm config 100\npct status 101"],
  ["dump directory metadata", "ls -l /var/lib/vz/dump\ndu -sh /var/lib/vz/dump\ndf -h /var/lib/vz"],
  ["a new backup copied into the dump directory", "cp /tmp/vzdump-qemu-100-2026_11_09-02_00_00.vma.zst /var/lib/vz/dump/"],
  // Wie auf dem VPS (cockpit-vps-snapshot create, Jochen 28.09.2026) ist die
  // Rotation des Werkzeugs frei, auch aus dem Plan aufgerufen (Auftrag t_5f5c89fe).
  ["the host snapshot helper with its own rotation", "/usr/bin/python3 /usr/local/lib/wireguard-ops-cockpit/cockpit-host-snapshot create cockpit-run-abcd1234 --guests\n/usr/local/lib/wireguard-ops-cockpit/cockpit-host-snapshot list"],
  ["storage config read", "cat /etc/pve/storage.cfg\ngrep -n prune-backups /etc/pve/storage.cfg /etc/vzdump.conf\ncat /etc/pve/jobs.cfg"],
  ["guest disks are not backups (doorkeeper X4)", "pvesm free local-lvm:vm-100-disk-1"],
  ["a temporary dump directory elsewhere", "rm -rf /tmp/dump"],
  ["prune dry run in its other spellings", "pvesm prune-backups local --dry-run=1 --keep-last 2\npvesm prune-backups local --dry-run true"],
  ["pvesh read without a leading slash", "pvesh get nodes/box/qemu"],
  ["find -delete of logs elsewhere", "find /srv/app/logs -name '*.log' -mtime +30 -delete"],
];

const gated: Array<[string, string]> = [
  // vzdump-Sicherungen löschen, kürzen, verschieben.
  ["rm in /var/lib/vz/dump", "rm -f /var/lib/vz/dump/vzdump-qemu-100-2026_11_09-02_00_00.vma.zst"],
  ["rm by glob in the dump directory", "rm -f /var/lib/vz/dump/*.zst"],
  ["rm after cd into the dump directory", "cd /var/lib/vz/dump && rm -f vzdump-lxc-101-*"],
  ["rm through an ancestor", "rm -rf /var/lib/vz"],
  ["find -delete in the dump directory", "find /var/lib/vz/dump -name 'vzdump-*' -mtime +7 -delete"],
  ["find -exec rm", "find /var/lib/vz/dump -type f -exec rm {} \\;"],
  ["mv out of the dump directory", "mv /var/lib/vz/dump/vzdump-qemu-100.vma.zst /tmp/"],
  ["truncate a backup", "truncate -s 0 /var/lib/vz/dump/vzdump-qemu-100.vma.zst"],
  ["shred a backup elsewhere by name", "shred -u /srv/backup/dump/vzdump-lxc-101-2026_11_09.tar.zst"],
  ["vma file by name", "rm /srv/x/alt.vma.lzo"],
  ["dump directory of a mounted storage", "rm -rf /mnt/pve/nas/dump"],
  ["dump directory of any storage by glob", "rm -f /mnt/pve/*/dump/*"],
  ["mounted storage by an ancestor", "rm -rf /mnt/pve/nas"],
  ["rsync --delete into the dump directory", "rsync -a --delete /tmp/leer/ /var/lib/vz/dump/"],
  ["dd over a backup", "dd if=/dev/zero of=/var/lib/vz/dump/vzdump-qemu-100.vma.zst bs=1M count=1"],
  ["rm through sudo, env and bash -c", "sudo env X=1 bash -c 'rm -f /var/lib/vz/dump/vzdump-qemu-100.vma.zst'"],
  ["rm through a variable", "D=/var/lib/vz/dump\nrm -f \"$D\"/vzdump-*"],
  ["rm with quotes in the path", "rm -f '/var/lib/vz/du'mp/x.log"],
  // pvesm, vzdump --remove.
  ["pvesm free on a backup volume", "pvesm free local:backup/vzdump-qemu-100-2026_11_09-02_00_00.vma.zst"],
  ["pvesm free through sudo and absolute path", "sudo /usr/sbin/pvesm free 'lab0:backup/vzdump-lxc-101.tar.zst'"],
  ["pvesm prune-backups", "pvesm prune-backups local --keep-last 1"],
  ["pvesm prune-backups with dry run off", "pvesm prune-backups local --dry-run 0"],
  ["vzdump --remove 1", "vzdump 100 --storage local --remove 1"],
  ["vzdump --remove", "vzdump --all --remove"],
  ["vzdump --remove=1", "vzdump 100 --remove=1"],
  ["vzdump with its own retention", "vzdump 100 --prune-backups keep-last=1"],
  // Aufbewahrung, Ziel, Zeitplan.
  ["pvesm set prune-backups", "pvesm set local --prune-backups keep-last=1"],
  ["pvesm set maxfiles", "pvesm set local --maxfiles 1"],
  ["pvesm set drops prune-backups", "pvesm set local --delete prune-backups"],
  ["storage.cfg retention edited", "sed -i 's/keep-daily=7/keep-daily=1/' /etc/pve/storage.cfg"],
  ["storage.cfg replaced", "cp /tmp/storage.cfg /etc/pve/storage.cfg"],
  ["vzdump.conf maxfiles appended", "echo 'maxfiles: 1' >> /etc/vzdump.conf"],
  ["vzdump.conf replaced by heredoc", "cat > /etc/vzdump.conf <<'EOF'\nstorage: local\nEOF"],
  ["jobs.cfg written", "tee /etc/pve/jobs.cfg < /tmp/jobs.cfg"],
  ["backup job changed over pvesh", "pvesh set /cluster/backup/backup-1a2b3c4d --enabled 0"],
  ["backup job deleted over pvesh", "pvesh delete /cluster/backup/backup-1a2b3c4d"],
  ["backup job retention over pvesh", "pvesh set /cluster/backup/backup-1a2b3c4d --prune-backups keep-last=1"],
  ["prune over pvesh", "pvesh delete /nodes/box/storage/local/prunebackups --type qemu --vmid 100"],
  ["backup volume deleted over pvesh", "pvesh delete /nodes/box/storage/local/content/local:backup/vzdump-qemu-100.vma.zst"],
  ["backup protection lifted over pvesh", "pvesh set /nodes/box/storage/local/content/local:backup/vzdump-qemu-100.vma.zst --protected 0"],
  ["vzdump --remove over pvesh", "pvesh create /nodes/box/vzdump --vmid 100 --remove 1"],
  // Gast-Snapshots und Gäste.
  ["qm delsnapshot", "qm delsnapshot 100 vor-update"],
  ["pct delsnapshot", "pct delsnapshot 101 vor-update"],
  ["qm rollback", "qm rollback 100 vor-update"],
  ["pct rollback", "/usr/sbin/pct rollback 101 vor-update"],
  ["qm destroy", "sudo qm destroy 100 --purge"],
  ["pct destroy", "pct destroy 101"],
  ["delsnapshot through env and bash -c", "env LANG=C bash -c 'qm delsnapshot 100 alt'"],
  ["delsnapshot with the command from a variable", "Q=qm\n$Q delsnapshot 100 alt"],
  ["delsnapshot with quotes in the name", "q\"m\" del'snapshot' 100 alt"],
  ["delsnapshot in a loop over listed names", "for n in $(qm listsnapshot 100 | awk '{print $2}'); do qm delsnapshot 100 \"$n\"; done"],
  ["delsnapshot from xargs", "qm listsnapshot 100 | grep -o 'alt-[0-9]*' | xargs -n1 qm delsnapshot 100"],
  ["delsnapshot through process substitution", "while read -r n; do qm delsnapshot 100 \"$n\"; done < <(qm listsnapshot 100)"],
  ["delsnapshot in a script this run writes", "cat > /usr/local/bin/aufraeumen.sh <<'EOF'\n#!/bin/bash\nqm delsnapshot 100 alt\nEOF\nchmod +x /usr/local/bin/aufraeumen.sh\n/usr/local/bin/aufraeumen.sh"],
  ["delsnapshot in a cron line", "cat > /etc/cron.d/aufraeumen <<'EOF'\n0 3 * * * root pct delsnapshot 101 alt\nEOF"],
  ["delsnapshot in python", "python3 -c 'import subprocess; subprocess.run([\"qm\", \"delsnapshot\", \"100\", \"alt\"])'"],
  ["delsnapshot over ssh", "ssh root@10.0.0.6 qm delsnapshot 100 alt"],
  ["snapshot deleted over pvesh", "pvesh delete /nodes/box/qemu/100/snapshot/vor-update"],
  ["rollback over pvesh", "pvesh create /nodes/box/lxc/101/snapshot/vor-update/rollback"],
  ["guest destroyed over pvesh", "pvesh delete /nodes/box/qemu/100 --purge 1"],
  ["snapshot deleted over the API", "curl -k -X DELETE -H \"Authorization: PVEAPIToken=$T\" https://10.0.0.6:8006/api2/json/nodes/box/qemu/100/snapshot/vor-update"],
  ["rollback over the API", "curl -k -X POST https://localhost:8006/api2/json/nodes/box/qemu/100/snapshot/vor-update/rollback"],
  ["guest destroyed over the API", "curl -k --request DELETE 'https://box:8006/api2/json/nodes/box/lxc/101'"],
  ["backup volume deleted over the API", "curl -k -X DELETE 'https://box:8006/api2/json/nodes/box/storage/local/content/local:backup/vzdump-qemu-100.vma.zst'"],
  ["backup job changed over the API", "curl -k -X PUT https://box:8006/api2/json/cluster/backup/backup-1a2b3c4d -d enabled=0"],
  ["backup protection lifted over the API", "curl -k -X PUT https://box:8006/api2/json/nodes/box/storage/local/content/local:backup/vzdump-qemu-100.vma.zst -d protected=0"],
  // Zweitprüfung (pruefer, 09.11.2026): Schreibweisen, die vorher durchrutschten.
  ["prune with a second dry run that is off", "pvesm prune-backups local --dry-run 1 --dry-run 0"],
  ["prune with a single-dash dry run that is off", "pvesm prune-backups local --dry-run 1 -dry-run 0"],
  ["prune with an abbreviated dry run that is off", "pvesm prune-backups local --dry-run 1 --dry 0"],
  ["guest destroyed over pvesh with an empty path part", "pvesh delete /nodes/box/qemu//100"],
  ["rollback over pvesh with an empty path part", "pvesh create /nodes/box/qemu/100/snapshot/x//rollback"],
  ["snapshot deleted over pvesh with an empty path part", "pvesh delete /nodes/box/qemu/100/snapshot//x"],
  ["backup job changed over pvesh without a leading slash", "pvesh set cluster/backup/backup-1 --enabled 0"],
  ["backup job deleted over pvesh without a leading slash", "pvesh delete cluster/backup/backup-1"],
  ["guest destroyed over pvesh with an option before the path", "pvesh delete --noproxy /nodes/box/qemu/100"],
  ["find -delete by name in an unknown storage", "find /srv/pve-backup/dump -name 'vzdump-*' -mtime +7 -delete"],
  ["find -exec rm by vma name", "find /srv -name '*.vma.zst' -exec rm {} +"],
  ["guest destroyed over wget", "wget -qO- --method=DELETE https://box:8006/api2/json/nodes/box/qemu/100"],
  ["PBS backup volume freed with --storage", "pvesm free backup/vm/100/2026-11-09T02:00:00Z --storage pbs"],
];

describe("backup bolt, box (t_5f5c89fe): reading and routine stay free", () => {
  it.each(free)("%s", (_label, run) => {
    expect(hits(run)).toEqual([]);
  });

  it("a plain vzdump is a hint for the doorkeeper, not a bolt hit", () => {
    expect(hits("vzdump 100 --storage local")).toEqual([]);
    expect(focus("vzdump 100 --storage local")).toEqual([expect.objectContaining({ kind: "mention" })]);
  });
});

describe("backup bolt, box (t_5f5c89fe): vzdump backups and guest snapshots stay behind the bolt", () => {
  it.each(gated)("%s", (_label, run) => {
    expect(hits(run).length).toBeGreaterThan(0);
  });

  // Die Rotation des Helfers läuft in cockpit-host-snapshot, nicht im Plan. Ein Plan,
  // der Snapshots der Namensform cockpit-run-* selbst löscht, nimmt früheren Läufen
  // (oder diesem) den Rückweg — wie cockpit-vps-snapshot delete auf dem VPS.
  it.each([
    ["the helper's own name form", "qm delsnapshot 100 cockpit-run-abcd1234"],
    ["the name form as a prefix", "pct delsnapshot 101 cockpit-run-abcd1234-HAOS"],
    ["the name form as a substring", "qm delsnapshot 100 vor-update # cockpit-run-abcd1234"],
    ["the name form in an echo before the deletion", "echo cockpit-run-abcd1234 && qm delsnapshot 100 vor-update"],
    ["the name form over pvesh", "pvesh delete /nodes/box/qemu/100/snapshot/cockpit-run-abcd1234"],
  ])("deleting snapshots by plan text stays gated: %s", (_label, run) => {
    expect(hits(run).length).toBeGreaterThan(0);
  });

  it("a gated line in a check counts as well", () => {
    expect(hits("true", "qm rollback 100 vor-update")).toEqual([expect.objectContaining({ where: "C1:L1", kind: "backup" })]);
  });

  it("a harmless read does not launder a deletion in the same line", () => {
    expect(hits("qm listsnapshot 100 && qm delsnapshot 100 alt").length).toBeGreaterThan(0);
    expect(hits("pvesm list local; pvesm free local:backup/vzdump-qemu-100.vma.zst").length).toBeGreaterThan(0);
  });
});
