#!/bin/bash

cat << EOF >> ${NUXEO_CONF}

nuxeo.append.templates.my=postgresql

nuxeo.cluster.enabled=true
nuxeo.cluster.nodeid=nuxeo-node-${RANDOM}

nuxeo.s3storage.bucket=${S3_BUCKET}
nuxeo.s3storage.region=eu-west-1

nuxeo.s3storage.directdownload.expire=3600
nuxeo.s3storage.directdownload=true

nuxeo.s3storage.useDirectUpload=true
nuxeo.s3storage.s3DirectUpload.bucket_prefix=upload_transient/

nuxeo.s3storage.transient.roleArn=${S3_UPLOAD_ROLE_ARN}
nuxeo.s3storage.transient.bucket=${S3_BUCKET}
nuxeo.s3storage.transient.bucket_prefix=upload/

elasticsearch.client=RestClient
elasticsearch.httpEnabled=true
elasticsearch.addressList=https://${OPENSEARCH_ENDPOINT}
audit.elasticsearch.enabled=true
elasticsearch.httpReadOnly.baseUrl=https://${OPENSEARCH_ENDPOINT}

kafka.enabled=true
kafka.bootstrap.servers=${MSK_ENDPOINT}
nuxeo.stream.work.enabled=true

nuxeo.db.name=nuxeo
nuxeo.db.user=nuxeo
nuxeo.db.password=${DB_PASSWORD}
nuxeo.db.host=${DB_ENDPOINT}
nuxeo.db.port=5432

nuxeo.vcs.max-pool-size=30

session.timeout=600
nuxeo.selection.selectAllEnabled=true
nuxeo.video.transaction.timeout.seconds=1800
EOF

if [ "${DISABLE_PROCESSING}" == "true" ]; then

echo "Adding conf to disable queues"

cat << EOF > ${NUXEO_HOME}/nxserver/config/disable-processing-config.xml
<?xml version="1.0" encoding="UTF-8"?>
<component name="nuxeo-disable-processing" version="1.0.0">
    <require>org.nuxeo.runtime.started</require>
    <extension point="queues" target="org.nuxeo.ecm.core.work.service">
        <queue id="*" processing="false"/>
    </extension>
</component>
EOF

fi

