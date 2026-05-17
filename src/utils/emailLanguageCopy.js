import { normalizeEmailLanguage } from "./userLanguage.js";

const COPY = {
  en: {
    resetPassword: {
      subject: "Reset Your Fonlok Password",
      title: "Reset Your Password",
      body: (name) =>
        `Hi ${name}, we received a request to reset the password for your Fonlok account. Click the button below to create a new password. This link expires in <strong>1 hour</strong>.`,
      button: "Reset my password",
      footer:
        "For security, this link expires in 1 hour. &copy; ${year} Fonlok &mdash; Secure Escrow Payments",
      ignore:
        "If you did not request a password reset, you can safely ignore this email &mdash; your password will not change.",
      changedSubject: "Your Fonlok Password Has Been Changed",
      changedTitle: "Password Changed Successfully",
      changedBody: (name) =>
        `Hi ${name}, your Fonlok account password has been changed successfully. You can now sign in with your new password.`,
      changedWarning:
        'If you did not make this change, contact us immediately at <a href="mailto:${sender}" style="color:#dc2626;">${sender}</a>.',
    },
    loginOtp: {
      subject: "Your Fonlok Sign-In Code",
      title: "Your one-time sign-in code",
      body: (name) =>
        `Hi ${name}, we received a password sign-in for your Fonlok account. Enter the code below to finish signing in. This code expires in <strong>10 minutes</strong>.`,
      codeLabel: "One-time code",
      footer:
        "If you did not try to sign in, you can ignore this email and your account will remain secure.",
    },
    deliveryNotification: {
      subject: (invoiceName) => `Please Confirm Delivery: ${invoiceName}`,
      title: "Ready to Confirm Delivery?",
      body: (sellerName) =>
        `Hi! <strong>${sellerName}</strong> just marked their work as delivered for your invoice. Please review and confirm receipt so they can get paid.`,
      button: "Confirm Receipt & Release Funds",
    },
    invoicePaid: {
      subject: (invoiceNumber) =>
        `✅ Invoice Paid — Please Deliver | Invoice ${invoiceNumber} | Fonlok`,
      title: "Your Invoice Has Been Paid",
      body: (buyerName, sellerFirstName) =>
        `Hi ${sellerFirstName}, great news! <strong>${buyerName}</strong> has paid your invoice and the funds are now held securely in Fonlok escrow.`,
      nextTitle: "What to do now",
      nextStep1: "Deliver the product or service you agreed on with the buyer.",
      nextStep2:
        "Use the chat to keep the buyer updated and share proof of delivery.",
      nextStep3:
        "Once the buyer confirms receipt, Fonlok will release your funds immediately.",
      button: "Open Chat with Buyer",
      footer:
        "The funds will remain in escrow until the buyer confirms delivery. If there is a problem, either party may open a dispute and Fonlok will mediate fairly.",
    },
    paymentConfirmed: {
      subject: (invoiceNumber) =>
        `Payment Confirmed - Invoice ${invoiceNumber} | Fonlok`,
      simpleTitle: "Payment Confirmed",
      simpleBody:
        "Your payment has been received successfully. Your funds are held securely in escrow and will only be released to the seller once you confirm delivery.",
      milestoneTitle: "Payment Confirmed &mdash; Milestone Escrow Active",
      milestoneBody: (invoiceNumber) =>
        `Your payment for invoice <strong>${invoiceNumber}</strong> has been received. Your funds are held securely in escrow and will be released to the seller <strong>one milestone at a time</strong> &mdash; only after you explicitly approve each completed stage of work.`,
      milestoneNote:
        "The seller will work through each milestone. Once a milestone is marked complete, you will receive a <strong>separate email with a secure one-click release link</strong> for that milestone only. No funds are ever moved without your explicit confirmation.",
      milestoneHeader: "Your Milestones",
      milestoneInstructions: "How Milestone Releases Work",
      step1: "The seller completes a milestone and marks it as done.",
      step2:
        "You receive an email with a secure, one-time release link for that milestone only.",
      step3:
        "Click the link to review and confirm &mdash; funds are never released without your explicit approval.",
      step4:
        "Repeat for each subsequent milestone until the work is fully complete.",
      warning:
        "If you have concerns about any milestone, do not release payment. Use the secure chat to communicate with the seller, or open a dispute.",
      receiptMessage:
        "Your official payment receipt is attached to this email as a PDF.",
      downloadButton: "Download PDF Receipt",
      confirmButton: "Confirm Receipt &amp; Release Funds",
      codeMessage: "Alternatively, give this release code to the seller:",
    },
    chatInvite: {
      subject: (invoiceNumber) =>
        `Your Secure Chat Link - Invoice ${invoiceNumber} | Fonlok`,
      title: "You Can Now Chat with the Seller",
      body: (invoiceNumber) =>
        `Your payment for invoice <strong>${invoiceNumber}</strong> has been confirmed. Use the chat to communicate with the seller, ask questions, or request proof of delivery.`,
      problemTitle: "Have a Problem with Your Order?",
      problemBody:
        "If you did not receive what you ordered, or there is an issue with your order, you can open a dispute. A Fonlok admin will review the case and make a fair decision.",
      chatButton: "Open Chat",
      disputeButton: "Open a Dispute",
      footerNote:
        "Keep these links private - they are unique to your order. You received this email because a payment was confirmed on Fonlok.",
    },
    payoutConfirmed: {
      subject: (invoiceNumber) =>
        `Payout Confirmed - Invoice ${invoiceNumber} | Fonlok`,
      title: "Payout Confirmed &mdash; Funds Sent",
      body: (sellerName) =>
        `Hello ${sellerName}, the buyer has confirmed delivery and your funds have been transferred to your Mobile Money account.`,
      receiptMessage:
        "Your official payout receipt is attached to this email as a PDF. You can also download it at any time using the button below.",
      downloadButton: "Download PDF Receipt",
      grossAmount: "Gross Amount",
      feeLabel: "Fonlok Fee",
      amountSent: "Amount Sent",
      sentTo: "Sent To",
      status: "Status",
      paidOut: "Paid Out",
      footer:
        "Thank you for using Fonlok. This email confirms your payout has been processed. Please keep this receipt for your records.",
    },
    disputeOpened: {
      adminSubject: "URGENT: Dispute Opened — Admin Review Required",
      sellerSubject: (invoiceNumber) =>
        `Dispute Opened — Invoice ${invoiceNumber}`,
      buyerSubject: (invoiceNumber) =>
        `Dispute Opened — Invoice ${invoiceNumber}`,
      adminTitle: "A Dispute Has Been Opened",
      sellerTitle: "A Dispute Has Been Opened On Your Invoice",
      buyerTitle: "Your Dispute Has Been Opened",
      adminBody: (userName, invoiceNumber) =>
        `User <strong>${userName}</strong> has opened a dispute on invoice <strong>${invoiceNumber}</strong>. Review the case details and make a fair decision.`,
      sellerBody: (buyerName, invoiceNumber) =>
        `<strong>${buyerName}</strong> has opened a dispute on your invoice <strong>${invoiceNumber}</strong>. You can respond via the secure chat.`,
      buyerBody: (invoiceNumber) =>
        `Your dispute on invoice <strong>${invoiceNumber}</strong> has been opened. A Fonlok admin will review your case.`,
      button: "View Dispute Details",
    },
    weeklyDigest: {
      subject: "📊 Your Weekly Revenue Report — Fonlok",
      title: "Your Weekly Revenue Report",
      subtitle: "Here's how you're doing on Fonlok this week.",
      invoicesPaid: "Invoices paid",
      fundsReceived: "Funds received",
      pendingMilestones: "Pending milestones",
      button: "Open Revenue & Stats",
    },
  },
  fr: {
    resetPassword: {
      subject: "Réinitialisez votre mot de passe Fonlok",
      title: "Réinitialisez votre mot de passe",
      body: (name) =>
        `Bonjour ${name}, nous avons reçu une demande de réinitialisation du mot de passe de votre compte Fonlok. Cliquez sur le bouton ci-dessous pour créer un nouveau mot de passe. Ce lien expire dans <strong>1 heure</strong>.`,
      button: "Réinitialiser mon mot de passe",
      footer:
        "Pour des raisons de sécurité, ce lien expire dans 1 heure. &copy; ${year} Fonlok &mdash; Paiements sécurisés par séquestre",
      ignore:
        "Si vous n'avez pas demandé de réinitialisation, vous pouvez ignorer cet e-mail en toute sécurité &mdash; votre mot de passe ne changera pas.",
      changedSubject: "Votre mot de passe Fonlok a été modifié",
      changedTitle: "Mot de passe modifié avec succès",
      changedBody: (name) =>
        `Bonjour ${name}, le mot de passe de votre compte Fonlok a été modifié avec succès. Vous pouvez maintenant vous connecter avec votre nouveau mot de passe.`,
      changedWarning:
        'Si vous n\'êtes pas à l\'origine de ce changement, contactez-nous immédiatement à <a href="mailto:${sender}" style="color:#dc2626;">${sender}</a>.',
    },
    loginOtp: {
      subject: "Votre code de connexion Fonlok",
      title: "Votre code de connexion à usage unique",
      body: (name) =>
        `Bonjour ${name}, une connexion par mot de passe a été demandée pour votre compte Fonlok. Saisissez le code ci-dessous pour terminer la connexion. Ce code expire dans <strong>10 minutes</strong>.`,
      codeLabel: "Code à usage unique",
      footer:
        "Si vous n'avez pas essayé de vous connecter, vous pouvez ignorer cet e-mail et votre compte restera sécurisé.",
    },
    deliveryNotification: {
      subject: (invoiceName) =>
        `Veuillez confirmer la livraison : ${invoiceName}`,
      title: "Prêt à confirmer la livraison ?",
      body: (sellerName) =>
        `Bonjour ! <strong>${sellerName}</strong> vient de marquer son travail comme livré pour votre facture. Veuillez vérifier et confirmer la réception afin qu'il puisse être payé.`,
      button: "Confirmer la réception et libérer les fonds",
    },
    invoicePaid: {
      subject: (invoiceNumber) =>
        `✅ Facture payée — Veuillez livrer | Facture ${invoiceNumber} | Fonlok`,
      title: "Votre facture a été payée",
      body: (buyerName, sellerFirstName) =>
        `Bonjour ${sellerFirstName}, bonne nouvelle ! <strong>${buyerName}</strong> a payé votre facture et les fonds sont maintenant conservés en toute sécurité en séquestre Fonlok.`,
      nextTitle: "Que faire maintenant",
      nextStep1:
        "Livrez le produit ou le service que vous avez convenu avec l'acheteur.",
      nextStep2:
        "Utilisez le chat pour tenir l'acheteur informé et partager une preuve de livraison.",
      nextStep3:
        "Une fois que l'acheteur confirme la réception, Fonlok libérera immédiatement vos fonds.",
      button: "Ouvrir le chat avec l'acheteur",
      footer:
        "Les fonds restent en séquestre jusqu'à ce que l'acheteur confirme la livraison. S'il y a un problème, l'une ou l'autre partie peut ouvrir un litige et Fonlok arbitrera équitablement.",
    },
    paymentConfirmed: {
      subject: (invoiceNumber) =>
        `Paiement confirmé - Facture ${invoiceNumber} | Fonlok`,
      simpleTitle: "Paiement confirmé",
      simpleBody:
        "Votre paiement a été reçu avec succès. Vos fonds sont conservés de manière sécurisée en séquestre et ne seront libérés au vendeur qu'une fois que vous aurez confirmé la livraison.",
      milestoneTitle: "Paiement confirmé &mdash; Séquestre par jalons actif",
      milestoneBody: (invoiceNumber) =>
        `Votre paiement pour la facture <strong>${invoiceNumber}</strong> a été reçu. Vos fonds sont conservés de manière sécurisée en séquestre et seront libérés au vendeur <strong>un jalon à la fois</strong> &mdash; uniquement après que vous ayez explicitement approuvé chaque étape de travail complétée.`,
      milestoneNote:
        "Le vendeur travaillera à travers chaque jalon. Une fois qu'un jalon est marqué comme terminé, vous recevrez un <strong>email séparé avec un lien de libération sécurisé en un clic</strong> pour ce seul jalon. Aucun fonds n'est jamais déplacé sans votre confirmation explicite.",
      milestoneHeader: "Vos jalons",
      milestoneInstructions: "Comment fonctionnent les libérations de jalons",
      step1: "Le vendeur complète un jalon et le marque comme terminé.",
      step2:
        "Vous recevez un email avec un lien de libération unique et sécurisé pour ce seul jalon.",
      step3:
        "Cliquez sur le lien pour vérifier et confirmer &mdash; les fonds ne sont jamais libérés sans votre approbation explicite.",
      step4:
        "Répétez pour chaque jalon ultérieur jusqu'à ce que le travail soit entièrement terminé.",
      warning:
        "Si vous avez des préoccupations concernant un jalon, ne libérez pas le paiement. Utilisez le chat sécurisé pour communiquer avec le vendeur ou ouvrez un litige.",
      receiptMessage:
        "Votre reçu de paiement officiel est joint à cet e-mail en PDF.",
      downloadButton: "Télécharger le reçu en PDF",
      confirmButton: "Confirmer la réception et libérer les fonds",
      codeMessage: "Alternativement, donnez ce code de libération au vendeur :",
    },
    chatInvite: {
      subject: (invoiceNumber) =>
        `Votre lien de chat sécurisé - Facture ${invoiceNumber} | Fonlok`,
      title: "Vous pouvez maintenant discuter avec le vendeur",
      body: (invoiceNumber) =>
        `Votre paiement pour la facture <strong>${invoiceNumber}</strong> a été confirmé. Utilisez le chat pour communiquer avec le vendeur, poser des questions ou demander une preuve de livraison.`,
      problemTitle: "Avez-vous un problème avec votre commande ?",
      problemBody:
        "Si vous n'avez pas reçu ce que vous avez commandé ou s'il y a un problème avec votre commande, vous pouvez ouvrir un litige. Un administrateur Fonlok examinera le cas et prendra une décision équitable.",
      chatButton: "Ouvrir le chat",
      disputeButton: "Ouvrir un litige",
      footerNote:
        "Gardez ces liens privés - ils sont uniques à votre commande. Vous avez reçu cet e-mail parce qu'un paiement a été confirmé sur Fonlok.",
    },
    payoutConfirmed: {
      subject: (invoiceNumber) =>
        `Paiement confirmé - Facture ${invoiceNumber} | Fonlok`,
      title: "Paiement confirmé &mdash; Fonds envoyés",
      body: (sellerName) =>
        `Bonjour ${sellerName}, l'acheteur a confirmé la livraison et vos fonds ont été transférés sur votre compte Mobile Money.`,
      receiptMessage:
        "Votre reçu de paiement officiel est joint à cet e-mail en PDF. Vous pouvez également le télécharger à tout moment en utilisant le bouton ci-dessous.",
      downloadButton: "Télécharger le reçu en PDF",
      grossAmount: "Montant brut",
      feeLabel: "Frais Fonlok",
      amountSent: "Montant envoyé",
      sentTo: "Envoyé à",
      status: "Statut",
      paidOut: "Paiement effectué",
      footer:
        "Merci d'utiliser Fonlok. Cet e-mail confirme que votre paiement a été traité. Veuillez conserver ce reçu pour vos dossiers.",
    },
    disputeOpened: {
      adminSubject: "URGENT : Litige ouvert — Révision administrative requise",
      sellerSubject: (invoiceNumber) =>
        `Litige ouvert — Facture ${invoiceNumber}`,
      buyerSubject: (invoiceNumber) =>
        `Litige ouvert — Facture ${invoiceNumber}`,
      adminTitle: "Un litige a été ouvert",
      sellerTitle: "Un litige a été ouvert sur votre facture",
      buyerTitle: "Votre litige a été ouvert",
      adminBody: (userName, invoiceNumber) =>
        `L'utilisateur <strong>${userName}</strong> a ouvert un litige sur la facture <strong>${invoiceNumber}</strong>. Examinez les détails du dossier et prenez une décision équitable.`,
      sellerBody: (buyerName, invoiceNumber) =>
        `<strong>${buyerName}</strong> a ouvert un litige sur votre facture <strong>${invoiceNumber}</strong>. Vous pouvez répondre via le chat sécurisé.`,
      buyerBody: (invoiceNumber) =>
        `Votre litige sur la facture <strong>${invoiceNumber}</strong> a été ouvert. Un administrateur Fonlok examinera votre dossier.`,
      button: "Voir les détails du litige",
    },
    weeklyDigest: {
      subject: "📊 Votre rapport de revenu hebdomadaire — Fonlok",
      title: "Votre rapport de revenu hebdomadaire",
      subtitle: "Voici comment vous vous débrouillez sur Fonlok cette semaine.",
      invoicesPaid: "Factures payées",
      fundsReceived: "Fonds reçus",
      pendingMilestones: "Jalons en attente",
      button: "Ouvrir Revenus & Statistiques",
    },
  },
};

function compile(template, values) {
  return template.replace(/\$\{(\w+)\}/g, (_, key) =>
    String(values[key] ?? ""),
  );
}

export function getEmailLanguageCopy(language) {
  return COPY[normalizeEmailLanguage(language)];
}

export function buildEmailCopy(language, section) {
  return getEmailLanguageCopy(language)[section];
}

export function interpolateEmailCopy(template, values) {
  return compile(template, values);
}
