# Use the official Puppeteer image which includes all required system dependencies and Chrome
FROM ghcr.io/puppeteer/puppeteer:latest

# Set environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Switch to root user to copy files and install dependencies
USER root

# Set the working directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Ensure the correct permissions for the non-root user that comes with the Puppeteer image
RUN chown -R pptruser:pptruser /usr/src/app

# Switch back to the non-root user for security
USER pptruser

# Expose the port the app runs on
EXPOSE 3000

# Command to run the application
CMD ["node", "server.js"]
