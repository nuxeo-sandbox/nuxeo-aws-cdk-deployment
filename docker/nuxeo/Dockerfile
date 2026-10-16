# syntax=docker/dockerfile:1
# Upstream image is Oracle Linux 9 (slim, FIPS enabled)
# Change the Nuxeo version, if necessary (LTS 2025.5 or later is required for Kafka in KRaft mode)
ARG NUXEO_VERSION=2025.25
FROM docker-private.packages.nuxeo.com/nuxeo/nuxeo:${NUXEO_VERSION}

# We need to be root to run dnf commands
USER 0

# Set UTF8 default locale
ENV LANG="en_US.UTF-8" \
    LANGUAGE="en_US:en" \
    LC_ALL="en_US.UTF-8"

# Install FFmpeg, mediainfo and codecs
# EPEL is already enabled in the base image, RPM Fusion also needs the CodeReady Builder repository
RUN dnf -y install dnf-plugins-core && \
    dnf config-manager --set-enabled ol9_codeready_builder && \
    dnf -y install https://mirrors.rpmfusion.org/free/el/rpmfusion-free-release-9.noarch.rpm && \
    dnf -y install mediainfo ffmpeg x264 x265 opus flac libvpx libvorbis-devel && \
    dnf clean all

# Install Fonts
RUN dnf -y install google-noto-sans-cjk-jp-fonts && dnf clean all

#Install codecs for Imagemagick
RUN dnf -y install librsvg2-tools libwebp-tools && dnf clean all

# Set back original (nuxeo) user
USER 900

# Install packages at build time
# The CLID is mounted as a build secret (see buildSecrets in lib/nuxeo-aws-cdk-stack.js) so it is not stored in the image
# Since LTS 2025, the OpenSearch search client, audit and UID generator backends are separate packages
RUN --mount=type=secret,id=clid,uid=900 \
    /install-packages.sh --clid "$(cat /run/secrets/clid)" \
      nuxeo-web-ui \
      amazon-s3-online-storage \
      nuxeo-search-client-opensearch1 \
      nuxeo-audit-opensearch1 \
      nuxeo-uidgen-opensearch1

COPY injectenv.sh /docker-entrypoint-initnuxeo.d/injectenv.sh

# !!! END OF FILE !!!
