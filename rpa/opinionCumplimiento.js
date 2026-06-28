const { is, to, getBrowserPage, saveBase64File, uploadFile, removeFile, opinionCumplimentoInformacion } = require('../tools');
const { processCaptcha } = require('../captcha/captcha');

module.exports = async (args) => {
  // ANTES: se abría la página de aterrizaje /consultas/20777/... y se raspaba el
  // href del botón ".actionButton" para abrir el login. El SAT cambió esa página
  // y el botón ya no existe → "Url no encontrada" / "waiting for `.actionButton`
  // ... 45000ms exceeded". AHORA vamos DIRECTO a la URL de login (el segmento
  // /login/), que es justo a donde apuntaba el actionButton. El FORMULARIO de
  // login de la Opinión está en la PÁGINA (no dentro de un iframe, a diferencia de
  // la Constancia); el iframe sólo aparece DESPUÉS del submit con el PDF.
  const url = 'https://www.sat.gob.mx/consultas/login/20777/consulta-tu-opinion-de-cumplimiento-de-obligaciones-fiscales';
  console.log(url);

  let pdf = '';
  let message = '';
  let status = false;
  let info = {};
  let validData = false;
  let loginMethod = '';

  const rfc = to.string(args?.rfc);
  const password = to.string(args?.password);
  const base64Cer = to.string(args?.base64Cer);
  const base64Key = to.string(args?.base64Key);
  let filePathCer = '';
  let filePathKey = '';

  if (password !== '') {
    if (rfc !== '') {
      console.log('Acceder a login con rfc contraseña...');
      loginMethod = 'password';
      validData = true;
    } else if (base64Cer !== '' && base64Key !== '') {
      console.log('Acceder a login con archivos cer, key y contraseña...');
      loginMethod = 'efirma';

      const fileName = new Date().toISOString().replace(/[:.-]/g, '');

      filePathCer = `./${fileName}.cer`;
      const isSavedCer = await saveBase64File(base64Cer, filePathCer);

      filePathKey = `./${fileName}.key`;
      const isSavedKey = await saveBase64File(base64Key, filePathKey);
      validData = isSavedCer && isSavedKey;
    }
  }

  if (validData) {
    console.log('Creando ajustes para puppeteer...');
    const puppeteer = args.puppeteer;
    const settings = require('../settings.json');
    const headless = settings.headless;
    const puppeteerArgs = settings.puppeteerArgs;

    console.log('Creando navegador...');
    const browser = await puppeteer.launch({
      headless: headless,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: puppeteerArgs,
      ignoreHTTPSErrors: true,
      defaultViewport: null,
    });

    let page = null;
    try {
      console.log(`Abriendo página ${url} ...`);
      page = await getBrowserPage(url, browser, settings);

      // El formulario de login de la Opinión está en la PÁGINA (no en iframe).
      // Esperamos el control del método elegido: e.firma (#btnCertificate, igual
      // que el RPA canónico de AguilarT1995) o contraseña (#contrasena). Timeout
      // ajustable (antes se esperaba 'iframe', que era incorrecto para Opinión).
      const waitSel = loginMethod === 'efirma' ? '#btnCertificate' : '#contrasena';
      console.log(`Esperar a formulario activo (${waitSel})...`);
      await page.waitForSelector(waitSel, { timeout: Number(process.env.SAT_IFRAME_TIMEOUT_MS) || 45000 });

      console.log(`Accediendo mediante ${loginMethod}...`);

      let isFormValid = false;

      if (loginMethod === 'password') {
        console.log('Dar click en botón contraseña...');
        await page.click('#contrasena');

        console.log('Esperando captcha...');
        await page.waitForSelector('#divCaptcha img');

        console.log('Escribir rfc...');
        await page.waitForSelector('#rfc', { visible: true });
        await page.type('#rfc', rfc);

        console.log('Escribir contraseña...');
        await page.waitForSelector('#password', { visible: true });
        await page.type('#password', password);

        console.log('Obtener imagen de captcha...');
        const base64 = await page.$eval('#divCaptcha img', (img) => img.src);

        console.log('Resolver captcha...');
        const captcha = await processCaptcha(base64);
        console.log(captcha);

        captchaText = captcha.text;
        isFormValid = captcha.isValid;

        if (isFormValid) {
          await page.waitForSelector('#userCaptcha', { visible: true });
          await page.type('#userCaptcha', captchaText);
        }
      } else if (loginMethod === 'efirma') {
        // Activar la pestaña e.firma si es un tab (no fatal si ya está activa o no
        // es clickeable). Análogo a lo que hace la Constancia con su propio botón.
        try { await page.click('#btnCertificate'); } catch (e) { console.log('btnCertificate no clickeable (quizá ya activo):', e?.message); }

        console.log('Subir archivos cer y key al formulario...');
        await uploadFile(page, '#fileCertificate', filePathCer);
        await uploadFile(page, '#filePrivateKey', filePathKey);

        console.log('Escribir contraseña...');
        await page.waitForSelector('#privateKeyPassword', { visible: true });
        await page.type('#privateKeyPassword', password);

        isFormValid = true;
      }

      if (isFormValid) {
        console.log('Submit al formulario...');
        await page.click('#submit');

        console.log('Esperando al resultado...');
        // Tras el login el SAT genera la opinión y la muestra dentro de un iframe.
        await page.waitForSelector('iframe', { timeout: Number(process.env.SAT_IFRAME_TIMEOUT_MS) || 45000 });

        console.log('Obteniendo base64 de PDF...');
        // El PDF puede venir como src de un iframe/embed/object o como enlace, y
        // como data:/blob:/URL. Buscamos en todos esos lugares; si no es ya un
        // data: URI autocontenido, lo descargamos DENTRO de la página (cookies de
        // sesión válidas) y lo convertimos a data URI.
        let pdfRef = await page.evaluate(() => {
          const looksPdf = (v) => !!v && (
            v.startsWith('data:application/pdf') || v.startsWith('blob:') ||
            /\.pdf(\?|#|$)/i.test(v) || v.includes('application/pdf')
          );
          for (const el of Array.from(document.querySelectorAll('iframe'))) { if (looksPdf(el.src)) return el.src; }
          for (const el of Array.from(document.querySelectorAll('embed'))) { if (looksPdf(el.src)) return el.src; }
          for (const el of Array.from(document.querySelectorAll('object'))) { if (looksPdf(el.data)) return el.data; }
          for (const a of Array.from(document.querySelectorAll('a'))) { if (looksPdf(a.href)) return a.href; }
          const f = document.querySelector('iframe');
          return f ? f.src : '';
        });

        if (pdfRef && !pdfRef.startsWith('data:')) {
          const conv = await page.evaluate(async (u) => {
            try {
              const res = await fetch(u, { credentials: 'include' });
              const blob = await res.blob();
              return await new Promise((resolve) => {
                const r = new FileReader();
                r.onloadend = () => resolve(r.result);
                r.onerror = () => resolve('');
                r.readAsDataURL(blob);
              });
            } catch (e) { return ''; }
          }, pdfRef);
          if (conv) pdfRef = conv;
        }
        pdf = pdfRef || '';

        if (is.string(pdf) && pdf.includes('application/pdf')) {
          status = true;
          message = 'PDF de opinión de cumplimiento generado';

          try {
            const buffer = Buffer.from(String(pdf).replace(/^data:[^,]*,/, ''), 'base64');
            console.log('opinionCumplimentoInformacion');
            info = await opinionCumplimentoInformacion(buffer);
          } catch (er) {
            console.log(er);
          }
        } else {
          message = 'Login OK pero no se encontró el PDF de la opinión (revisar estructura del resultado del SAT).';
        }
      }
    } catch (e) {
      // Diagnóstico enriquecido: además del error, capturamos a DÓNDE quedó el
      // navegador (url + título), para distinguir "URL de login equivocada /
      // redirección inesperada" de "selector no encontrado" en un solo vistazo.
      let diag = '';
      try { if (page) diag = ` [url=${page.url()} | title=${await page.title()}]`; } catch (_) {}
      const error = (e?.message || String(e)) + diag;
      console.log(error);
      message = error;
    }

    console.log('Finalizado');
    await browser.close();

    if (loginMethod === 'efirma') {
      await removeFile(filePathCer);
      await removeFile(filePathKey);
    }
  } else message = `Error al acceder mediante ${loginMethod}`;

  return { status, message, info, pdf };
};
