# Check the apache config for nextcloudwejosde Cat BOTH et
> Generated 2026-07-12T11:41:55.101Z

## Prompt
Check the apache config for nextcloud.wejos.de. Cat BOTH /etc/apache2/sites-enabled/001-nextcloud-le-ssl.conf AND /etc/apache2/sites-enabled/000-nextcloud80.conf completely. Also run: apachectl -S to show the ServerName and name-based virtual hosts. I need to see the full vhost configuration to understand how proxy passes are set up.

## Planner Output
```
## Required Permissions
/usr/bin/cat
/usr/sbin/apachectl
'''bash
#!/usr/bin/env bash
echo "=== /etc/apache2/sites-enabled/000-nextcloud80.conf ==="
/usr/bin/cat /etc/apache2/sites-enabled/000-nextcloud80.conf
echo ""
echo "=== /etc/apache2/sites-enabled/001-nextcloud-le-ssl.conf ==="
/usr/bin/cat /etc/apache2/sites-enabled/001-nextcloud-le-ssl.conf
echo ""
echo "=== apachectl -S ==="
/usr/sbin/apachectl -S
'''
```