const AWS = require('aws-sdk');
const fetch = require('node-fetch');
const moment = require('moment');
const fs = require('fs');
const Handlebars = require('handlebars');

const pipedriveKey = process.env.PIPEDRIVE_KEY;
const pipedriveBaseUrl = 'https://api.pipedrive.com/v1/';
const pipedriveStages = '20,19,6'.split(',');
const pipedriveUser = '2643534';

const emailHtmlTemplate = Handlebars.compile(fs.readFileSync('src/email.html', 'utf8'));
const emailTxtTemplate = Handlebars.compile(fs.readFileSync('src/email.txt', 'utf8'));
const smsTemplate = Handlebars.compile(fs.readFileSync('src/smsTemplate.txt', "utf8"));

AWS.config.region = 'eu-west-1';
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_KEY
});
const sns = new AWS.SNS();
const ses = new AWS.SES();

exports.handler = function (event, context, callback) {

    Promise.all(pipedriveStages.map(processStage))
        .then(function () {
            callback(null, null)
        }).catch(callback)
};

function processStage(stage) {
    return findRottenDeals(stage)
        .then(function (deals) {
            const promises = deals.map(function (deal) {
                processDeal(deal);
            });

            console.log(deals.length + ' rotten deals');
            return Promise.all(promises);
        })
}

function findRottenDeals(pipedriveStage) {
    return fetch(pipedriveBaseUrl + 'deals?&user_id=' + pipedriveUser + '&stage_id=' + pipedriveStage + '&status=open&start=0&api_token=' + pipedriveKey + '&limit=2')
        .then(function (value) {
            return value.json()
        })
        .then(function (value) {
            var deals = value.data || [];
            return deals.filter(deal => moment().isAfter(moment(deal.rotten_time)));
        });
}

function markDealLost(deal) {

    return fetch(pipedriveBaseUrl + 'deals/' + deal.id + '?api_token=' + pipedriveKey, {
        method: 'PUT',
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            status: 'lost',
            lost_reason: 'Automated: deal rotting'
        })
    })
}

function processDeal(deal) {
    let person = deal.person_id;
    deal.firstName = person.name.split(' ')[0];
    deal.phoneNumber = formatNumberForAWS(person.phone[0].value);
    deal.email = person.email[0].value;

    return Promise.all([sendEmail(deal), sendSms(deal)])
        .then(function () {
            return markDealLost(deal);
        })
        .catch(function (error) {
            console.error('error with deal ' + deal.id, error);
        })
        .then(function () {
            console.log(deal.id + ' processed')
        });

}

function sendEmail(deal) {
    return ses.sendEmail({
        Destination: {
            BccAddresses: [deal.cc_email],
            CcAddresses: [],
            ToAddresses: [
                deal.person_id.email[0].value
            ]
        },
        Message: {
            Body: {
                Html: {
                    Charset: "UTF-8",
                    Data: emailHtmlTemplate(deal)
                },
                Text: {
                    Charset: "UTF-8",
                    Data: emailTxtTemplate(deal)
                }
            },
            Subject: {
                Charset: "UTF-8",
                Data: "Code Your Future Application"
            }
        },
        Source: deal.user_id.email,
    }).promise();
}

function formatNumberForAWS(number) {
    if (number.startsWith('07')) {
        return '+44' + number.substring(1, number.length);
    }
    return number;
}

function sendSms(deal) {

    var params = {
        Message: smsTemplate(deal),
        MessageStructure: 'string',
        PhoneNumber: deal.phoneNumber,
        MessageAttributes: {
            'AWS.SNS.SMS.SenderID': {
                DataType: 'String',
                StringValue: 'CYF'
            }
        }
    };

    return sns.publish(params).promise();
}

