# Backup runner: the MongoDB image already has mongodump/mongorestore and mongod (used to verify backups);
# rclone uploads copies to Cloudflare R2.
FROM mongo:8.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends rclone ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["loop"]
