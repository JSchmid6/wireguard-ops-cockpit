<?php

declare(strict_types=1);

use OCA\AppAPI\Fetcher\ExAppFetcher;
use OC\Files\AppData\Factory;
use OCP\Files\NotFoundException;
use OCP\Server;

if ($argc !== 2 || !preg_match('/^[a-z][a-z0-9_]{1,63}$/', $argv[1])) {
	fwrite(STDERR, "invalid Nextcloud app id\n");
	exit(64);
}

define('OC_CONSOLE', 1);
require_once '/var/www/nextcloud/lib/base.php';

$appData = Server::get(Factory::class)->get('appstore');
$root = $appData->getFolder('/');
try {
	$root->getFile('appapi_apps.json')->delete();
} catch (NotFoundException) {
	// A missing cache is already the desired pre-fetch state.
}

$apps = Server::get(ExAppFetcher::class)->get();
foreach ($apps as $app) {
	if (($app['id'] ?? null) === $argv[1]) {
		$version = (string)($app['releases'][0]['version'] ?? 'unknown');
		fwrite(STDOUT, "official AppAPI catalog refreshed; {$argv[1]}={$version}\n");
		exit(0);
	}
}

fwrite(STDERR, "official AppAPI catalog refreshed but requested app is unavailable\n");
exit(69);
