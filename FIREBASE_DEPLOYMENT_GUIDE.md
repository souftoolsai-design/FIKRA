# دليل تهيئة ونشر منصة SoufTools AI على Firebase Hosting 🚀

تم إعداد هذا الدليل ليوفر لك مساراً واضحاً ومباشراً لنشر منصة **SoufTools AI** على استضافة **Firebase Hosting** مع دعم كامل لمعمارية **Next.js 15 (App Router)** وميزات العرض من جانب الخادم (SSR) واستدعاءات الذكاء الاصطناعي الآمنة عبر API الخادم.

---

## 🏗️ البنية المجهزة للمشروع

تم ضبط ملفات المشروع لتتوافق مع معايير Firebase الحديثة:

1. **`.firebaserc`**:
   - تم ربط المشروع تلقائياً بمعرف مشروع Firebase الخاص بك: `souftoolsheb-92e1c`.

2. **`firebase.json`**:
   - تفعيل خيار `frameworksBackend` مع تحديد المنطقة `us-central1`.
   - ضبط ترويسات التخزين المؤقت (Cache-Control) للأصول الثابتة `/_next/static/**` لأقصى سرعة تحميل.
   - إضافة ترويسات الأمان الأساسية (`X-Content-Type-Options`, `X-Frame-Options`).
   - ربط قواعد حماية Firestore من ملف `firestore.rules`.

3. **`apphosting.yaml`**:
   - إعداد مسبق لدعم الجيل الجديد من استضافة تطبيقات الويب **Firebase App Hosting** المخصص لـ Next.js.

4. **`package.json`**:
   - إضافة أوامر سريعة للنشر:
     - `npm run deploy:firebase`: نشر الاستضافة وقواعد البيانات معاً.
     - `npm run deploy:hosting`: نشر استضافة الويب فقط.
     - `npm run deploy:rules`: نشر وتحديث قواعد Firestore فقط.

---

## ⚡ خطوات النشر المباشر

### 1. تثبيت أداة Firebase CLI
إذا لم تكن الأداة مثبتة على جهازك:
```bash
npm install -g firebase-tools
```

### 2. تسجيل الدخول إلى Firebase
```bash
firebase login
```

### 3. تفعيل دعم أطر عمل الويب (Web Frameworks)
هذه الميزة تمكن Firebase من فحص مشروع Next.js تلقائياً، بنائه، ورفع الواجهات والوظائف السحابية تلقائياً:
```bash
firebase experiments:enable webframeworks
```

### 4. إعداد المتغيرات السرية على بيئة الخادم (Gemini API Key)
نظراً لأن استدعاءات نماذج الذكاء الاصطناعي تتم حصراً من جانب الخادم، يجب توفير مفتاح Gemini السحابي لـ Cloud Functions:
```bash
firebase functions:secrets:set GEMINI_API_KEY
```
*(أو يمكنك إضافتها عبر لوحة تحكم Google Cloud Run / Firebase Console المرتبطة بالمشروع).*

### 5. تشغيل أمر النشر
يمكنك استخدام سكربت المساعدة الجاهز:
```bash
bash scripts/deploy-firebase.sh
```
أو تشغيل الأمر مباشرة:
```bash
npm run deploy:firebase
```

---

## 🌐 الروابط بعد النشر

بمجرد اكتمال النشر، ستكون المنصة متاحة فوراً على الروابط العالمية:
- `https://souftoolsheb-92e1c.web.app`
- `https://souftoolsheb-92e1c.firebaseapp.com`

ويمكنك إضافة نطاقك المخصص (Custom Domain) بسهولة من:
**Firebase Console -> Hosting -> Add custom domain**.
