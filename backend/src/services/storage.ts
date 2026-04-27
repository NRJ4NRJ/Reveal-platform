import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

const DEFAULT_BUCKET = "branding-assets";

function getSupabaseAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function persistUploadedFile(file: Express.Multer.File, folder: string): Promise<string> {
  const extension = path.extname(file.originalname || "");
  const filename = `${folder}/${uuidv4()}${extension}`;
  const supabase = getSupabaseAdminClient();

  if (supabase) {
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_BUCKET;
    const { error } = await supabase.storage.from(bucket).upload(filename, file.buffer, {
      contentType: file.mimetype,
      upsert: true,
    });

    if (error) {
      throw error;
    }

    const { data } = supabase.storage.from(bucket).getPublicUrl(filename);
    return data.publicUrl;
  }

  const uploadDir = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
  fs.mkdirSync(uploadDir, { recursive: true });
  const localFilename = `${uuidv4()}${extension}`;
  const localPath = path.join(uploadDir, localFilename);
  await fs.promises.writeFile(localPath, file.buffer);
  return `/uploads/${localFilename}`;
}
