import nodemailer from "nodemailer";

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user) {
    return null; // SMTP not configured, will log to console
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

const FROM = process.env.SMTP_FROM || "noreply@safetyskilltrack.com";

export async function sendPasswordReset(to: string, token: string, baseUrl: string) {
  const link = `${baseUrl}/reset-password?token=${token}`;
  const subject = "Réinitialisation de votre mot de passe";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #27295A;">Réinitialisation de mot de passe</h2>
      <p>Vous avez demandé la réinitialisation de votre mot de passe Safety Skill Track.</p>
      <p>Cliquez sur le bouton ci-dessous pour définir un nouveau mot de passe :</p>
      <a href="${link}" style="display:inline-block;background:#27295A;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0;">
        Réinitialiser mon mot de passe
      </a>
      <p style="color:#666;font-size:12px;">Ce lien expire dans 1 heure. Si vous n'avez pas fait cette demande, ignorez cet e-mail.</p>
    </div>
  `;

  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[EMAIL SIMULATION] To: ${to}\nSubject: ${subject}\nReset link: ${link}`);
    return;
  }
  await transporter.sendMail({ from: FROM, to, subject, html });
}

export async function sendCredentials(to: string, firstName: string, username: string, password: string, companyName: string) {
  const subject = `Vos identifiants Safety Skill Track – ${companyName}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #27295A;">Bienvenue sur Safety Skill Track</h2>
      <p>Bonjour ${firstName},</p>
      <p>Votre compte a été créé sur la plateforme Safety Skill Track pour <strong>${companyName}</strong>.</p>
      <div style="background:#f5f5f5;padding:16px;border-radius:8px;margin:16px 0;">
        <p style="margin:4px 0;"><strong>Identifiant :</strong> ${username}</p>
        <p style="margin:4px 0;"><strong>Mot de passe temporaire :</strong> ${password}</p>
      </div>
      <p style="color:#666;font-size:12px;">Connectez-vous et changez votre mot de passe lors de votre première connexion.</p>
    </div>
  `;

  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[EMAIL SIMULATION] To: ${to}\nSubject: ${subject}\nUsername: ${username}\nPassword: ${password}`);
    return;
  }
  await transporter.sendMail({ from: FROM, to, subject, html });
}

// ITER11: vérification changement d'email Super Admin
export async function sendEmailVerification(to: string, token: string, baseUrl: string) {
  const link = `${baseUrl}/verify-email?token=${token}`;
  const subject = "Vérifiez votre nouvelle adresse e-mail – Safety Skill Track";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #27295A;">Vérification de votre nouvelle adresse e-mail</h2>
      <p>Vous avez demandé à changer votre adresse e-mail sur Safety Skill Track.</p>
      <p>Cliquez sur le bouton ci-dessous pour confirmer votre nouvelle adresse :</p>
      <a href="${link}" style="display:inline-block;background:#27295A;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0;">
        Confirmer mon adresse e-mail
      </a>
      <p style="color:#666;font-size:12px;">Ce lien expire dans 1 heure. Si vous n'avez pas fait cette demande, ignorez cet e-mail.</p>
    </div>
  `;

  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[EMAIL SIMULATION] To: ${to}\nSubject: ${subject}\nVerification link: ${link}`);
    return;
  }
  await transporter.sendMail({ from: FROM, to, subject, html });
}

export async function sendTestCompletionNotification(to: string, adminName: string, employeeName: string, testName: string) {
  const subject = `Test terminé – ${employeeName}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #27295A;">Notification Safety Skill Track</h2>
      <p>Bonjour ${adminName},</p>
      <p>Le salarié <strong>${employeeName}</strong> a terminé le test <strong>${testName}</strong>.</p>
      <p>Connectez-vous à votre espace administrateur pour consulter les résultats.</p>
    </div>
  `;

  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[EMAIL SIMULATION] To: ${to}\nSubject: ${subject}`);
    return;
  }
  await transporter.sendMail({ from: FROM, to, subject, html });
}
