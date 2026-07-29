<?php

declare(strict_types=1);

/**
 * Re-run the supported AppAPI initialization and enable handshake for one
 * already registered ExApp. This neither unregisters the app nor recreates its
 * container or persistent volume.
 */

use OCA\AppAPI\Service\AppAPIService;
use OCA\AppAPI\Service\ExAppService;

if (($argc !== 2 && $argc !== 3)
	|| preg_match('/^[a-z][a-z0-9_]{1,63}$/', $argv[1]) !== 1
	|| ($argc === 3 && $argv[2] !== '--restart')) {
	fwrite(STDERR, "usage: nextcloud-exapp-reinitialize.php <app-id> [--restart]\n");
	exit(64);
}

$appId = $argv[1];
$restart = $argc === 3;
require_once '/var/www/nextcloud/lib/base.php';

$exAppService = \OC::$server->get(ExAppService::class);
$appApiService = \OC::$server->get(AppAPIService::class);
$exApp = $exAppService->getExApp($appId);
if ($exApp === null) {
	fwrite(STDERR, "registered ExApp not found\n");
	exit(67);
}

if ($restart) {
	if (!$appApiService->disableExApp($exApp)) {
		fwrite(STDERR, "failed to stop ExApp through AppAPI\n");
		exit(1);
	}
	$exApp = $exAppService->getExApp($appId);
	if ($exApp === null || !$appApiService->enableExApp($exApp)) {
		fwrite(STDERR, "failed to restart ExApp through AppAPI\n");
		exit(1);
	}
	$exApp = $exAppService->getExApp($appId);
}

$appApiService->dispatchExAppInitInternal($exApp);
$error = $exAppService->waitInitStepFinish($appId);
if ($error !== '') {
	fwrite(STDERR, $error . "\n");
	exit(1);
}

$exApp = $exAppService->getExApp($appId);
if ($exApp === null || !$appApiService->enableExApp($exApp)) {
	fwrite(STDERR, "ExApp initialization completed but enable handshake failed\n");
	exit(1);
}

$exApp = $exAppService->getExApp($appId);
$result = json_encode([
	'appId' => $appId,
	'restarted' => $restart,
	'enabled' => $exApp?->getEnabled() ?? false,
	'status' => $exApp?->getStatus() ?? [],
], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n";
while (ob_get_level() > 0) {
	ob_end_clean();
}
fwrite(STDOUT, $result);
