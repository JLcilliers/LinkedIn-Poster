import { getSupabaseClient, getStorageBucket, MediaAsset, Platform, logActivity } from '../config/supabase';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';

// Supported image types
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

// Platform-specific image requirements
export const PLATFORM_IMAGE_REQUIREMENTS: Record<Platform, {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
  preferredAspectRatio: string;
  maxSizeBytes: number;
}> = {
  linkedin: {
    minWidth: 552,
    minHeight: 276,
    maxWidth: 7680,
    maxHeight: 4320,
    preferredAspectRatio: '1.91:1',
    maxSizeBytes: 8 * 1024 * 1024,
  },
  facebook: {
    minWidth: 600,
    minHeight: 315,
    maxWidth: 2048,
    maxHeight: 2048,
    preferredAspectRatio: '1.91:1',
    maxSizeBytes: 8 * 1024 * 1024,
  },
  instagram: {
    minWidth: 320,
    minHeight: 320,
    maxWidth: 1440,
    maxHeight: 1800,
    preferredAspectRatio: '1:1',
    maxSizeBytes: 8 * 1024 * 1024,
  },
  x: {
    minWidth: 600,
    minHeight: 335,
    maxWidth: 4096,
    maxHeight: 4096,
    preferredAspectRatio: '16:9',
    maxSizeBytes: 5 * 1024 * 1024,
  },
};

export interface UploadResult {
  success: boolean;
  mediaAsset?: MediaAsset;
  error?: string;
}

export interface ImageMetadata {
  width?: number;
  height?: number;
  mimeType: string;
  fileSizeBytes: number;
}

export class MediaService {
  private bucketName: string;

  constructor() {
    this.bucketName = config.supabase.storageBucket || 'social-media-assets';
  }

  /**
   * Upload an image from a local file path
   */
  async uploadFromFile(
    filePath: string,
    label: string,
    description?: string,
    platformsAllowed?: Platform[]
  ): Promise<UploadResult> {
    try {
      // Check file exists
      if (!fs.existsSync(filePath)) {
        return { success: false, error: `File not found: ${filePath}` };
      }

      // Read file
      const fileBuffer = fs.readFileSync(filePath);
      const fileName = path.basename(filePath);
      const mimeType = this.getMimeType(fileName);

      if (!mimeType || !ALLOWED_MIME_TYPES.includes(mimeType)) {
        return { success: false, error: `Unsupported file type: ${fileName}` };
      }

      if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
        return { success: false, error: `File too large: ${fileBuffer.length} bytes (max ${MAX_FILE_SIZE_BYTES})` };
      }

      return this.uploadBuffer(fileBuffer, fileName, mimeType, label, description, platformsAllowed);
    } catch (error) {
      logger.error('Failed to upload from file', { filePath, error });
      return { success: false, error: `Upload failed: ${error}` };
    }
  }

  /**
   * Upload an image from a remote URL
   */
  async uploadFromUrl(
    imageUrl: string,
    label: string,
    description?: string,
    platformsAllowed?: Platform[]
  ): Promise<UploadResult> {
    try {
      logger.info('Downloading image from URL', { imageUrl });

      const response = await fetch(imageUrl, {
        headers: {
          'User-Agent': 'Social-Autoposter/1.0',
        },
        timeout: 30000,
      });

      if (!response.ok) {
        return { success: false, error: `Failed to fetch image: ${response.status} ${response.statusText}` };
      }

      const contentType = response.headers.get('content-type') || '';
      const mimeType = contentType.split(';')[0].trim();

      if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
        return { success: false, error: `Unsupported content type: ${mimeType}` };
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length > MAX_FILE_SIZE_BYTES) {
        return { success: false, error: `Image too large: ${buffer.length} bytes` };
      }

      // Generate filename from URL or use default
      const urlPath = new URL(imageUrl).pathname;
      const ext = this.getExtensionFromMime(mimeType);
      const fileName = path.basename(urlPath) || `image-${Date.now()}.${ext}`;

      return this.uploadBuffer(buffer, fileName, mimeType, label, description, platformsAllowed);
    } catch (error) {
      logger.error('Failed to upload from URL', { imageUrl, error });
      return { success: false, error: `Upload from URL failed: ${error}` };
    }
  }

  /**
   * Upload a buffer to Supabase Storage
   */
  async uploadBuffer(
    buffer: Buffer,
    fileName: string,
    mimeType: string,
    label: string,
    description?: string,
    platformsAllowed?: Platform[]
  ): Promise<UploadResult> {
    try {
      const supabase = getSupabaseClient();
      const storage = getStorageBucket(this.bucketName);

      // Generate unique path
      const timestamp = Date.now();
      const uniqueId = uuidv4().substring(0, 8);
      const ext = path.extname(fileName) || `.${this.getExtensionFromMime(mimeType)}`;
      const storagePath = `uploads/${timestamp}-${uniqueId}${ext}`;

      // Upload to storage
      const { error: uploadError } = await storage.upload(storagePath, buffer, {
        contentType: mimeType,
        upsert: false,
      });

      if (uploadError) {
        logger.error('Storage upload failed', { error: uploadError });
        return { success: false, error: `Storage upload failed: ${uploadError.message}` };
      }

      // Get public URL
      const { data: urlData } = storage.getPublicUrl(storagePath);
      const publicUrl = urlData.publicUrl;

      // Create media asset record
      const mediaAsset: Omit<MediaAsset, 'id' | 'created_at' | 'updated_at'> = {
        label,
        description: description || null,
        supabase_path: storagePath,
        public_url: publicUrl,
        platforms_allowed: platformsAllowed || ['linkedin', 'facebook', 'instagram', 'x'],
        file_size_bytes: buffer.length,
        mime_type: mimeType,
        width: null,
        height: null,
      };

      const { data: insertedAsset, error: insertError } = await supabase
        .from('media_assets')
        .insert(mediaAsset)
        .select()
        .single();

      if (insertError || !insertedAsset) {
        logger.error('Failed to create media asset record', { error: insertError });
        // Try to clean up the uploaded file
        await storage.remove([storagePath]);
        return { success: false, error: `Failed to create asset record: ${insertError?.message}` };
      }

      await logActivity(
        'MEDIA_UPLOADED',
        `Uploaded media asset: ${label}`,
        'MediaAsset',
        insertedAsset.id,
        { publicUrl, mimeType, sizeBytes: buffer.length }
      );

      logger.info('Media asset uploaded successfully', {
        id: insertedAsset.id,
        path: storagePath,
        publicUrl,
      });

      return { success: true, mediaAsset: insertedAsset as MediaAsset };
    } catch (error) {
      logger.error('Upload buffer failed', { error });
      return { success: false, error: `Upload failed: ${error}` };
    }
  }

  /**
   * Extract and upload an article's OpenGraph or main image
   */
  async extractAndUploadArticleImage(
    articleId: string,
    articleHtml: string,
    articleUrl: string
  ): Promise<UploadResult | null> {
    try {
      // Try to find OpenGraph image
      const ogImageMatch = articleHtml.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
        || articleHtml.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);

      let imageUrl: string | null = null;

      if (ogImageMatch && ogImageMatch[1]) {
        imageUrl = ogImageMatch[1];
      } else {
        // Try to find first significant image in content
        const imgMatch = articleHtml.match(/<img[^>]*src=["']([^"']+)["'][^>]*>/i);
        if (imgMatch && imgMatch[1]) {
          imageUrl = imgMatch[1];
        }
      }

      if (!imageUrl) {
        logger.info('No image found for article', { articleId });
        return null;
      }

      // Handle relative URLs
      if (imageUrl.startsWith('/')) {
        const baseUrl = new URL(articleUrl);
        imageUrl = `${baseUrl.protocol}//${baseUrl.host}${imageUrl}`;
      } else if (!imageUrl.startsWith('http')) {
        const baseUrl = new URL(articleUrl);
        imageUrl = `${baseUrl.protocol}//${baseUrl.host}/${imageUrl}`;
      }

      logger.info('Found article image', { articleId, imageUrl });

      return this.uploadFromUrl(
        imageUrl,
        `Article image: ${articleId}`,
        `Automatically extracted image from article`,
        ['linkedin', 'facebook', 'instagram', 'x']
      );
    } catch (error) {
      logger.error('Failed to extract article image', { articleId, error });
      return null;
    }
  }

  /**
   * Get a media asset by ID
   */
  async getMediaAsset(id: string): Promise<MediaAsset | null> {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('media_assets')
        .select('*')
        .eq('id', id)
        .single();

      if (error || !data) {
        return null;
      }

      return data as MediaAsset;
    } catch (error) {
      logger.error('Failed to get media asset', { id, error });
      return null;
    }
  }

  /**
   * Get multiple media assets by IDs
   */
  async getMediaAssets(ids: string[]): Promise<MediaAsset[]> {
    if (ids.length === 0) return [];

    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('media_assets')
        .select('*')
        .in('id', ids);

      if (error || !data) {
        return [];
      }

      return data as MediaAsset[];
    } catch (error) {
      logger.error('Failed to get media assets', { ids, error });
      return [];
    }
  }

  /**
   * Delete a media asset
   */
  async deleteMediaAsset(id: string): Promise<boolean> {
    try {
      const supabase = getSupabaseClient();

      // Get the asset first to find its storage path
      const asset = await this.getMediaAsset(id);
      if (!asset) {
        return false;
      }

      // Delete from storage
      const storage = getStorageBucket(this.bucketName);
      await storage.remove([asset.supabase_path]);

      // Delete from database
      const { error } = await supabase
        .from('media_assets')
        .delete()
        .eq('id', id);

      if (error) {
        logger.error('Failed to delete media asset record', { id, error });
        return false;
      }

      await logActivity(
        'MEDIA_DELETED',
        `Deleted media asset: ${asset.label}`,
        'MediaAsset',
        id
      );

      return true;
    } catch (error) {
      logger.error('Failed to delete media asset', { id, error });
      return false;
    }
  }

  /**
   * List all media assets
   */
  async listMediaAssets(limit: number = 50, offset: number = 0): Promise<MediaAsset[]> {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('media_assets')
        .select('*')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error || !data) {
        return [];
      }

      return data as MediaAsset[];
    } catch (error) {
      logger.error('Failed to list media assets', { error });
      return [];
    }
  }

  /**
   * Upload a screenshot for visual verification
   */
  async uploadScreenshot(
    socialPostId: string,
    screenshotBuffer: Buffer,
    platform: Platform
  ): Promise<string | null> {
    try {
      const storage = getStorageBucket(this.bucketName);
      const timestamp = Date.now();
      const storagePath = `screenshots/${socialPostId}/verification-${platform}-${timestamp}.png`;

      const { error: uploadError } = await storage.upload(storagePath, screenshotBuffer, {
        contentType: 'image/png',
        upsert: true,
      });

      if (uploadError) {
        logger.error('Screenshot upload failed', { error: uploadError });
        return null;
      }

      const { data: urlData } = storage.getPublicUrl(storagePath);
      return urlData.publicUrl;
    } catch (error) {
      logger.error('Failed to upload screenshot', { socialPostId, error });
      return null;
    }
  }

  // Helper methods
  private getMimeType(fileName: string): string | null {
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    return mimeTypes[ext] || null;
  }

  private getExtensionFromMime(mimeType: string): string {
    const extensions: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
    };
    return extensions[mimeType] || 'jpg';
  }
}

// Singleton instance
let mediaServiceInstance: MediaService | null = null;

export function getMediaService(): MediaService {
  if (!mediaServiceInstance) {
    mediaServiceInstance = new MediaService();
  }
  return mediaServiceInstance;
}
