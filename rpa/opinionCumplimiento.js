const { is, to, getBrowserPage, saveBase64File, uploadFile, removeFile, opinionCumplimentoInformacion } = require('../tools');
const { processCaptcha } = require('../captcha/captcha');

module.exports = async (args) => {
  const url = 'https://www.sat.gob.mx/consultas/20777/consulta-tu-opinion-de-cumplimiento-de-obligaciones-fiscales';
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

      // Upload CER
      filePathCer = `./${fileName}.cer`;
      const isSavedCer = await saveBase64File(base64Cer, filePathCer);

      // Upload KEY
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

    try {
      console.log('Esperando respuesta de página...');
      const mainPage = await getBrowserPage(url, browser, settings);

      // Esperar a que el enlace de descarga ("actionButton") esté en el DOM antes
      // de leer su href. La página del SAT a veces renderiza lento y el botón se
      // inyecta de forma dinámica; leer demasiado pronto devolvía '' → el error
      // espurio "Url no encontrada". SIN try/catch local: si el elemento de verdad
      // no aparece (página cambiada / bloqueada), el TimeoutError sube al catch
      // externo y se reporta como un "Waiting for selector `.actionButton` failed:
      // …ms exceeded" real y diagnosticable, en vez de enmascararse. Ajustable con
      // SAT_ACTIONBUTTON_TIMEOUT_MS (default 45000).
      await mainPage.waitForSelector('.actionButton', { timeout: Number(process.env.SAT_ACTIONBUTTON_TIMEOUT_MS) || 45000 });

      const href = await mainPage.evaluate(() => {
        try {
          return document.getElementsByClassName('actionButton')[0].href;
        } catch (e) {
          return '';
        }
      });

      if (href === '') message = 'Url no encontrada';
      else {
        console.log(`Abriendo página ${href} ...`);
        const page = await getBrowserPage(href, browser, settings);

        console.log('Esperar a formulario activo...');
      await page.waitForSelector('iframe', { timeout: Number(process.env.SAT_IFRAME_TIMEOUT_MS) || 45000 });

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

          // Mismo timeout ajustable que el iframe de arriba: tras el submit la
          // página de resultado (con el PDF en un iframe) también puede tardar si
          // el SAT va lento; el default 30s de Puppeteer se quedaba corto.
          console.log('Esperando al formulario...');
          await page.waitForSelector('iframe', { timeout: Number(process.env.SAT_IFRAME_TIMEOUT_MS) || 45000 });

          console.log('Obteniendo base64 de PDF...');
          pdf = await page.evaluate(() => {
            const iframe = document.querySelector('iframe');
            return iframe?.src || '';
          });

          if (is.string(pdf) && pdf.includes('application/pdf')) {
            status = true;
            message = 'PDF de opinión de cumplimiento generado';

            try {
              const res = await fetch(pdf);
              const blob = await res.blob();
              const buffer = Buffer.from(await blob.arrayBuffer());

              console.log('opinionCumplimentoInformacion');
              info = await opinionCumplimentoInformacion(buffer);
            } catch (er) {
              console.log(er);
            }
          }
        }
      }
    } catch (e) {
      const error = e?.message;
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
