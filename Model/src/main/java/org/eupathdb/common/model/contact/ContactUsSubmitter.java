package org.eupathdb.common.model.contact;

import static org.gusdb.fgputil.FormatUtil.escapeHtml;
import static org.gusdb.fgputil.FormatUtil.join;

import org.gusdb.fgputil.web.RequestData;
import org.gusdb.wdk.model.WdkModel;
import org.gusdb.wdk.model.WdkModelException;
import org.gusdb.wdk.model.config.ModelConfig;
import org.gusdb.wdk.model.user.User;

public class ContactUsSubmitter {  
  
  private ContactUsSubmitter() {}
  
  public static void createAndSendEmail(
      ContactUsParams params, 
      User user,
      RequestData requestData,
      WdkModel wdkModel,
      EmailSender emailSender) throws WdkModelException {
    ModelConfig modelConfig = wdkModel.getModelConfig();
        
    String supportEmail = modelConfig.getSupportEmail();
    String uid = Long.toString(user.getUserId());
    String version = wdkModel.getBuildNumber();
    String website = wdkModel.getDisplayName();
    
    String replyEmail = params.reporterEmail.isEmpty() 
        ? supportEmail 
        : params.reporterEmail;
    String ccField = join(params.ccEmails, ", ");
    
    String metaInfo =
        "ReplyTo: " + replyEmail + "\n" +
        "CC: " + ccField + "\n" +
        "Privacy preferences: " + "\n" +
        "Uid: " + uid + "\n" +
        "Browser information: " + requestData.getUserAgent() + "\n" +
        "Referrer page: " + requestData.getReferrer() + "\n" +
        "WDK Model version: " + version;

    String redmineContent = "****THIS IS NOT A REPLY**** \nThis is an automatic" +
        " response, that includes your message for your records, to let you" +
        " know that we have received your email and will get back to you as" +
        " soon as possible. Thanks so much for contacting us!\n\nThis was" +
        " your message:\n\n---------------------\n" + params.message + 
        "\n---------------------";

    String redmineMetaInfo = "Project: usersupportrequests\n" + "Category: " + 
        website + "\n" + "\n" +
        metaInfo + "\n" + 
        "Client IP Address: " + requestData.getIpAddress() + "\n" +
        "WDK Host: " + requestData.getAppHostName() + " (" + requestData.getAppHostAddress() + ")\n";
    
    String smtpServer = modelConfig.getSmtpServer();
    
    // Send auto-reply
    emailSender.sendEmail(
        smtpServer, 
        replyEmail, 
        supportEmail, 
        params.subject,
        escapeHtml(metaInfo + "\n\n" + redmineContent + "\n\n"), 
        ccField, 
        params.attachments
    );

    // Send support email
    emailSender.sendEmail(
        smtpServer, 
        supportEmail, 
        replyEmail, 
        params.subject,
        escapeHtml(metaInfo + "\n\n" + params.message + "\n\n"), 
        null, 
        params.attachments
    );
    
    // Send Redmine email
    emailSender.sendEmail(
        smtpServer, 
        wdkModel.getProperties().get("REDMINE_TO_EMAIL"), 
        wdkModel.getProperties().get("REDMINE_FROM_EMAIL"), 
        params.subject,
        escapeHtml(redmineMetaInfo + "\n\n" + params.message + "\n\n"), 
        null, 
        params.attachments
    );    
  }
  
}