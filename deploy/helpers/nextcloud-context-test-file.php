<?php

declare(strict_types=1);

/**
 * Create one non-destructive Context Chat verification document through the
 * supported Nextcloud Files API. Existing files are never overwritten.
 */

use OCP\Files\IRootFolder;
use OCP\IUserManager;

if (($argc !== 3 && $argc !== 4) || ($argc === 4 && $argv[3] !== '--inspect')) {
	fwrite(STDERR, "usage: nextcloud-context-test-file.php <user-id> <marker> [--inspect]\n");
	exit(64);
}

$userId = $argv[1];
$marker = $argv[2];
$inspect = $argc === 4;
if (preg_match('/^[A-Za-z0-9_.@-]{1,64}$/', $userId) !== 1
	|| preg_match('/^[a-z0-9][a-z0-9-]{7,63}$/', $marker) !== 1) {
	fwrite(STDERR, "invalid user id or marker\n");
	exit(64);
}

require_once '/var/www/nextcloud/lib/base.php';

$server = \OC::$server;
$userManager = $server->get(IUserManager::class);
if (!$userManager->userExists($userId)) {
	fwrite(STDERR, "Nextcloud user does not exist\n");
	exit(67);
}

try {
	$rootFolder = $server->get(IRootFolder::class);
	$userFolder = $rootFolder->getUserFolder($userId);
	$testFolder = $userFolder->getOrCreateFolder('Cockpit E2E Tests');
	$fileName = "context-chat-$marker.txt";
	if ($inspect) {
		if (!$testFolder->nodeExists($fileName)) {
			fwrite(STDERR, "test document does not exist\n");
			exit(66);
		}
		$file = $testFolder->get($fileName);
		$result = json_encode([
			'userId' => $userId,
			'path' => '/Cockpit E2E Tests/' . $fileName,
			'fileId' => $file->getId(),
			'size' => $file->getSize(),
			'marker' => $marker,
		], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n";
		while (ob_get_level() > 0) {
			ob_end_clean();
		}
		fwrite(STDOUT, $result);
		fwrite(STDERR, $result);
		exit(0);
	}

	if ($testFolder->nodeExists($fileName)) {
		fwrite(STDERR, "test document already exists; refusing to overwrite it\n");
		exit(73);
	}

	$content = <<<TEXT
Nextcloud Context Chat end-to-end verification document

Verification marker: $marker
Purpose: prove that a document created through the Nextcloud Files API is indexed and retrievable through Context Chat.
Retention: this harmless test document is intentionally left in Cockpit E2E Tests for human inspection.
TEXT;

	$file = $testFolder->newFile($fileName, $content . "\n");
	$result = json_encode([
		'userId' => $userId,
		'path' => '/Cockpit E2E Tests/' . $fileName,
		'fileId' => $file->getId(),
		'size' => $file->getSize(),
		'marker' => $marker,
	], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n";

	// Nextcloud starts an output buffer while bootstrapping. Flush it explicitly so
	// the signed runner handoff contains independently verifiable file evidence.
	while (ob_get_level() > 0) {
		ob_end_clean();
	}
	fwrite(STDOUT, $result);
	fwrite(STDERR, $result);
	exit(0);
} catch (\Throwable $e) {
	while (ob_get_level() > 0) {
		ob_end_clean();
	}
	fwrite(STDERR, "Context Chat test-file operation failed: " . $e->getMessage() . "\n");
	exit(1);
}
