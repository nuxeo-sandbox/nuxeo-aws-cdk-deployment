# Upstream image is Rocky Linux 9
# Change the source image, if necessary
FROM docker-private.packages.nuxeo.com/nuxeo/nuxeo:2023.9

ARG NUXEO_CLID

# We need to be root to run yum commands
USER 0

# Set UTF8 default locale
ENV LANG="en_US.UTF-8" \
    LANGUAGE="en_US:en" \
    LC_ALL="en_US.UTF-8"

# Install FFmpeg, mediainfo and codecs
RUN dnf config-manager --set-enabled crb && dnf -y install epel-release && \
    dnf -y install https://mirrors.rpmfusion.org/free/el/rpmfusion-free-release-9.noarch.rpm && \
    dnf -y install mediainfo ffmpeg x264 x265 opus flac libvpx && dnf --enablerepo=crb -y install libvorbis-devel

# Install Fonts
RUN dnf -y install google-noto-sans-cjk-jp-fonts

#Install codecs for Imagemagick
RUN dnf -y install librsvg2-tools && dnf --enablerepo=devel -y install libwebp-tools

RUN usermod -aG 998 nuxeo

# Set back original (nuxeo) user
USER 900

# Install packages at build time
RUN /install-packages.sh --clid $NUXEO_CLID nuxeo-web-ui amazon-s3-online-storage

COPY injectenv.sh /docker-entrypoint-initnuxeo.d/injectenv.sh

# !!! END OF FILE !!!