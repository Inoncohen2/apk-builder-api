import { createClient } from '@supabase/supabase-js';
import formidable from 'formidable';
import { readFileSync } from 'fs';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const form = formidable({ multiples: false, maxFileSize: 5 * 1024 * 1024 });
    
    const [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        resolve([fields, files]);
      });
    });

    // קבלת הנתונים
    const name = Array.isArray(fields.name) ? fields.name[0] : fields.name;
    const website_url = Array.isArray(fields.website_url) ? fields.website_url[0] : fields.website_url;
    const package_name = Array.isArray(fields.package_name) ? fields.package_name[0] : fields.package_name;
    const notification_email = Array.isArray(fields.notification_email) ? fields.notification_email[0] : fields.notification_email;
    const primary_color = Array.isArray(fields.primary_color) ? fields.primary_color[0] : fields.primary_color || '#2196F3';
    const themeMode = Array.isArray(fields.themeMode) ? fields.themeMode[0] : fields.themeMode || 'system';
    const navigation = Array.isArray(fields.navigation) ? fields.navigation[0] : fields.navigation;
    const pull_to_refresh = Array.isArray(fields.pull_to_refresh) ? fields.pull_to_refresh[0] : fields.pull_to_refresh;
    const orientation = Array.isArray(fields.orientation) ? fields.orientation[0] : fields.orientation || 'auto';
    const enable_zoom = Array.isArray(fields.enable_zoom) ? fields.enable_zoom[0] : fields.enable_zoom;
    const keep_awake = Array.isArray(fields.keep_awake) ? fields.keep_awake[0] : fields.keep_awake;
    const open_external_links = Array.isArray(fields.open_external_links) ? fields.open_external_links[0] : fields.open_external_links;
    const build_format = Array.isArray(fields.build_format) ? fields.build_format[0] : fields.build_format || 'apk';

    // אימות Package Name
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(package_name)) {
      return res.status(400).json({ 
        error: 'Package name לא תקין. השתמש בפורמט: com.company.appname' 
      });
    }

    // בדוק אם ה-Package Name כבר קיים
    const { data: existing } = await supabase
      .from('apps')
      .select('package_name')
      .eq('package_name', package_name)
      .single();

    if (existing) {
      return res.status(400).json({ 
        error: 'Package name כבר קיים. בחר שם אחר.' 
      });
    }

    // יצירת App ID ייחודי
    const appId = `app_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // העלאת אייקון ל-Supabase Storage
    let iconUrl = null;
    if (files.appIcon) {
      const iconFile = Array.isArray(files.appIcon) ? files.appIcon[0] : files.appIcon;
      const fileBuffer = readFileSync(iconFile.filepath);
      const fileName = `${appId}/icon.png`;

      const { error: uploadError } = await supabase.storage
        .from('app-icons')
        .upload(fileName, fileBuffer, {
          contentType: 'image/png',
          upsert: true
        });

      if (uploadError) {
        console.error('Icon upload error:', uploadError);
        return res.status(500).json({ error: 'שגיאה בהעלאת האייקון' });
      }

      const { data: urlData } = supabase.storage
        .from('app-icons')
        .getPublicUrl(fileName);

      iconUrl = urlData.publicUrl;
    }

    // שמירה בבסיס נתונים
    const { data: build, error: dbError } = await supabase
      .from('apps')
      .insert({
        app_id: appId,
        name,
        website_url,
        package_name,
        notification_email,
        icon_url: iconUrl,
        primary_color,
        navigation: navigation === 'true',
        pull_to_refresh: pull_to_refresh === 'true',
        orientation,
        enable_zoom: enable_zoom === 'true',
        keep_awake: keep_awake === 'true',
        open_external_links: open_external_links === 'true',
        build_format,
        status: 'pending',
        config: {
          theme_mode: themeMode,
          primary_color,
          navigation: navigation === 'true',
          pull_to_refresh: pull_to_refresh === 'true',
          orientation,
          enable_zoom: enable_zoom === 'true',
          keep_awake: keep_awake === 'true',
          open_external_links: open_external_links === 'true'
        }
      })
      .select()
      .single();

    if (dbError) {
      console.error('Database error:', dbError);
      return res.status(500).json({ error: 'שגיאה בשמירת הנתונים' });
    }

    // טריגר GitHub Actions
    const githubResponse = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPO}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          event_type: 'build-app',
          client_payload: {
            app_id: appId,
            name,
            website_url,
            package_name,
            icon_url: iconUrl,
            notification_email,
            primary_color,
            theme_mode: themeMode,
            navigation: navigation === 'true',
            pull_to_refresh: pull_to_refresh === 'true',
            orientation,
            enable_zoom: enable_zoom === 'true',
            keep_awake: keep_awake === 'true',
            open_external_links: open_external_links === 'true',
            build_format
          }
        })
      }
    );

    if (!githubResponse.ok) {
      console.error('GitHub trigger failed:', await githubResponse.text());
      
      await supabase
        .from('apps')
        .update({ status: 'failed' })
        .eq('app_id', appId);
      
      return res.status(500).json({ error: 'שגיאה בהפעלת הבנייה' });
    }

    // עדכון סטטוס ל-building
    await supabase
      .from('apps')
      .update({ status: 'building' })
      .eq('app_id', appId);

    res.json({
      success: true,
      app_id: appId,
      message: `הבנייה התחילה! תקבל מייל ל-${notification_email} תוך 5-10 דקות.`,
      estimated_time: '5-10 דקות'
    });

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: error.message });
  }
}
