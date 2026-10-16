#!/bin/bash

# Note: \${env:XXX} values are resolved by the Nuxeo launcher at startup, not by this script
cat << EOF >> ${NUXEO_CONF}

# postgresql-quartz-cluster includes postgresql and clusters the Quartz scheduler
# (tables created at deploy time, see sql/quartz-tables.sql)
nuxeo.append.templates.my=postgresql-quartz-cluster

nuxeo.cluster.enabled=true
nuxeo.cluster.nodeid=$(hostname)

nuxeo.s3storage.bucket=${S3_BUCKET}
nuxeo.s3storage.region=${AWS_REGION}

nuxeo.s3storage.directdownload.expire=3600
nuxeo.s3storage.directdownload=true

nuxeo.s3storage.useDirectUpload=true
nuxeo.s3storage.s3DirectUpload.bucket_prefix=upload_transient/

nuxeo.s3storage.transient.roleArn=${S3_UPLOAD_ROLE_ARN}
nuxeo.s3storage.transient.bucket=${S3_BUCKET}
nuxeo.s3storage.transient.bucket_prefix=upload/
nuxeo.s3storage.transient.region=${AWS_REGION}

# Used by the nuxeo-search-client-opensearch1, nuxeo-audit-opensearch1 and nuxeo-uidgen-opensearch1 packages
elasticsearch.addressList=https://${OPENSEARCH_ENDPOINT}
elasticsearch.httpReadOnly.baseUrl=https://${OPENSEARCH_ENDPOINT}

kafka.enabled=true
kafka.bootstrap.servers=${MSK_ENDPOINT}
nuxeo.stream.work.enabled=true

nuxeo.db.name=nuxeo
nuxeo.db.user=nuxeo
nuxeo.db.password=\${env:DB_PASSWORD}
nuxeo.db.host=${DB_ENDPOINT}
nuxeo.db.port=5432
nuxeo.db.validationQuery=SELECT 1
nuxeo.db.idle-timeout-minutes=10

nuxeo.vcs.max-pool-size=25
nuxeo.vcs.idle-timeout-minutes=5

session.timeout=600
# Not defined in the Nuxeo platform sources, probably a Web UI property: to be verified
nuxeo.selection.selectAllEnabled=true
nuxeo.video.transaction.timeout.seconds=1800

EOF

if [ "${DISABLE_PROCESSING}" == "true" ]; then

echo "Adding conf to disable queues"

cat << EOF >> ${NUXEO_CONF}
nuxeo.stream.processing.enabled=false
nuxeo.work.processing.enabled=false
EOF

fi

