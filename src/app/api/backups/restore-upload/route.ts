import { NextRequest, NextResponse } from 'next/server';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PROJECT_ROOT = process.env.FATE_DATA_ROOT || process.cwd();
const UPLOAD_DIR = join(PROJECT_ROOT, 'upload');

// POST /api/backups/restore-upload
//
// Accepts a multipart file upload (bundle zip) and saves it to upload/ directory.
// The actual restore is performed manually by the user via scripts.
//
// This endpoint just receives the file — restore is a separate step because
// it requires restarting dev server, which can't be done from API route.

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided. Use multipart/form-data with field "file".' },
        { status: 400 },
      );
    }

    // Validate file type
    if (!file.name.endsWith('.zip')) {
      return NextResponse.json(
        { error: 'File must be a .zip archive' },
        { status: 400 },
      );
    }

    // Validate file size (max 50MB)
    const MAX_SIZE = 50 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { error: `File too large. Max ${MAX_SIZE / 1024 / 1024}MB` },
        { status: 413 },
      );
    }

    // Ensure upload directory exists
    if (!existsSync(UPLOAD_DIR)) {
      mkdirSync(UPLOAD_DIR, { recursive: true });
    }

    // Save file
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const filepath = join(UPLOAD_DIR, file.name);
    writeFileSync(filepath, buffer);

    const sizeKB = Math.round(buffer.length / 1024);

    return NextResponse.json({
      success: true,
      filename: file.name,
      size: sizeKB,
      path: filepath,
      message: `Bundle uploaded to upload/${file.name}. Next step: ask the assistant to restore from this bundle.`,
    });
  } catch (e: any) {
    console.error('Restore upload error:', e);
    return NextResponse.json(
      { error: 'Upload failed', details: e.message },
      { status: 500 },
    );
  }
}
