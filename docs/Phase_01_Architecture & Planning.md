# 🎯 Phase 1 — Architecture & Planning

This is the most important phase.

Before creating an EC2 instance, VPC, EKS cluster or Terraform code, we first understand **what we are building and why**.

---

## 1.1 Business Requirement

Our StreamFlix platform should support:

### 👤 Customers

A customer should be able to:

```text
Register
   ↓
Login
   ↓
Browse Movies
   ↓
Search Content
   ↓
Select Movie
   ↓
Play Video
   ↓
Continue Watching
   ↓
Manage Subscription
```

### 👨‍💼 Admin

An administrator should be able to:

```text
Admin Login
     ↓
Upload Video
     ↓
Upload Metadata
     ↓
Video Processing
     ↓
Publish Content
     ↓
Available to Users
```

---

# 1.2 High-Level Architecture

Our final architecture will look approximately like this:

![Image](https://images.openai.com/static-rsc-4/96B-RMel3ZYpShcwbcAEOnruFTLqH6ED5HrljX-f4KT2ipE9GhaZdUACrh5dMG4ayQQ3vAdDdAp3JGU3yVMIZM0zKkD5rIp7MOGSz6ongMln0Vmie1yyrVlKv0JABuDaCP-IQmVPZnmcziVTQeFvntbY0MesCgeIjSGVv3f6DE4MVODwx6809tnRHqPFyGW5?purpose=fullsize)

![Image](https://images.openai.com/static-rsc-4/_JaYSE5vhNgxyLKVGoZGZzyl8Bp2usV8-jC5AhTeTVzVGHWx0Pt7x7-CIOE-YF3kWC9ddYf9jUX8gNGdl7F-m2x29pTk_sR6oZloZFtHYPsiq_0xHF4yLguAEu18ffBNRIMmnuE-brEsA7P3X3cmhfaTWLWqm2znCZEx1k7ygW6J_XLBl3e0pkjeFRrFtOX-?purpose=fullsize)

![Image](https://images.openai.com/static-rsc-4/0dxiBkX4LhVWmxDm6aQqyuoIRBtJUVbI4-JLa6ePDOXroc4WrecH6frV2t0IXISYAxbxIW3m-TZl1zjHw6SEraClm_I4F9ox7fIZqQQUUffGZkiAh0fb-IP1o2r3IAUrqN_ahkPL9fplIChGvj-VyR28A5LJey49Vmmivo_AFNQRVhFNx8Y8SVg5H3u8dPjM?purpose=fullsize)

![Image](https://images.openai.com/static-rsc-4/heHponysrLE7PhIzLcZfsYT4OTS-TSzvSl4mxryB1bx9KOg7Kgxj2oi5Z5gLF7TsVjGjcw4NX7mvVs5kmc38va62is57Mv3IzentptnLB3_KDE-h5MazB8P-XhJlupvOljvggf1N6r9bZIsMklLUGn8PVePXDltiYjCmA1PlTa6kFzXdRt2dO16eoV71gCIj?purpose=fullsize)

![Image](https://images.openai.com/static-rsc-4/9O2qPp_uPz8_RgkjthLjZTqUVKArCkm3nME5_F5ROBhb1D2NRd0WcLhcrKWIq7AQNrKFwSA_C52zjDJiajVCmjxywPLCb7uLiB658c_KZQXEyMq20296GANTFBHfRuG-OPChQaTOXbyGxVQLngypYKCVMsLIolMxVoZJb1G7yPInpJdRTIZ5A3d6qQAgF6Az?purpose=fullsize)

```text
                         ┌───────────────────┐
                         │      USERS        │
                         │ Web / Mobile / TV │
                         └─────────┬─────────┘
                                   │
                                   ▼
                         ┌───────────────────┐
                         │    Route 53       │
                         │       DNS         │
                         └─────────┬─────────┘
                                   │
                                   ▼
                         ┌───────────────────┐
                         │ CloudFront + WAF  │
                         │       CDN         │
                         └───────┬─────┬─────┘
                                 │     │
                    ┌────────────┘     └────────────┐
                    ▼                               ▼
             ┌─────────────┐                 ┌─────────────┐
             │     S3      │                 │ API Gateway │
             │ Frontend /  │                 │ / ALB       │
             │ Video       │                 └──────┬──────┘
             └─────────────┘                        │
                                                    ▼
                                          ┌──────────────────┐
                                          │       EKS        │
                                          │ Kubernetes       │
                                          └────────┬─────────┘
                                                   │
                          ┌────────────────────────┼────────────────────┐
                          │                        │                    │
                          ▼                        ▼                    ▼
                   ┌────────────┐          ┌────────────┐       ┌────────────┐
                   │ User       │          │ Content    │       │ Payment    │
                   │ Service    │          │ Service   │       │ Service    │
                   └─────┬──────┘          └─────┬──────┘       └─────┬──────┘
                         │                       │                    │
                         └──────────────┬────────┴────────────────────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
                    ▼                   ▼                   ▼
              ┌──────────┐       ┌────────────┐      ┌─────────────┐
              │ Aurora / │       │ DynamoDB   │      │ ElastiCache │
              │   RDS    │       │            │      │    Redis    │
              └──────────┘       └────────────┘      └─────────────┘


                 VIDEO INGESTION / PROCESSING
                 
 Admin
   │
   ▼
┌─────────────┐
│ Upload Video│
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ S3 Raw Video│
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ MediaConvert│
└──────┬──────┘
       │
       ▼
┌──────────────────┐
│ HLS/DASH Outputs │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ S3 Processed     │
│ Video Content    │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│    CloudFront    │
│       CDN        │
└────────┬─────────┘
         │
         ▼
       USERS
```

---

# 1.3 Why So Many AWS Services?

This project is intentionally designed to teach **real-world cloud architecture**, rather than simply deploying an application on EC2.

For example:

### DNS

**Amazon Route 53**

```text
streamflix.com
       ↓
    Route 53
```

Responsible for DNS resolution.

---

### CDN

**Amazon CloudFront**

Instead of users downloading videos directly from an AWS region:

```text
User
  ↓
CloudFront Edge Location
  ↓
S3
```

This reduces latency and improves scalability.

---

### Storage

**Amazon S3**

We'll use separate buckets logically for:

```text
S3
│
├── frontend
│
├── raw-videos
│
├── processed-videos
│
├── thumbnails
└── logs
```

---

# 1.4 Video Processing Architecture

This is one of the most important parts of the project.

Suppose an administrator uploads:

```text
movie.mp4
```

We don't want every user to download the original huge MP4.

Instead:

```text
                    movie.mp4
                        │
                        ▼
                  ┌──────────┐
                  │    S3    │
                  │   RAW    │
                  └────┬─────┘
                       │
                       ▼
                ┌─────────────┐
                │ MediaConvert│
                └──────┬──────┘
                       │
          ┌────────────┼─────────────┐
          ▼            ▼             ▼
       1080p         720p          480p
          │            │             │
          └────────────┼─────────────┘
                       ▼
                 HLS Manifest
                    .m3u8
                       │
                       ▼
                  S3 Processed
                       │
                       ▼
                   CloudFront
                       │
                       ▼
                     User
```

This gives us **adaptive bitrate streaming**.

For example:

```text
Excellent Internet
       ↓
     1080p

Good Internet
       ↓
      720p

Slow Internet
       ↓
      480p
```

---

# 1.5 Application Architecture

We won't initially create dozens of microservices.

We'll start with a manageable architecture:

```text
                    StreamFlix
                       │
          ┌────────────┴────────────┐
          │                         │
       Frontend                  Backend
          │                         │
     React / Next.js          REST APIs
                                    │
               ┌────────────────────┼───────────────────┐
               │                    │                   │
               ▼                    ▼                   ▼
           User API            Content API         Payment API
               │                    │                   │
               └────────────────────┼───────────────────┘
                                    │
                         ┌──────────┼──────────┐
                         ▼          ▼          ▼
                       RDS      DynamoDB     Redis
```

Later, we can evolve this into a larger microservices architecture.

---

# 1.6 Kubernetes Architecture

Our backend will eventually run on **Amazon EKS**.

```text
                    Amazon EKS
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
    Frontend       Backend APIs     Workers
        │              │              │
        │       ┌──────┼──────┐       │
        │       │      │      │       │
        │       ▼      ▼      ▼       │
        │     User  Content Payment   │
        │                              │
        └──────────────┬───────────────┘
                       │
                       ▼
                    Services
                       │
                 ┌─────┼──────┐
                 ▼     ▼      ▼
                RDS   Redis  DynamoDB
```

---

# 1.7 CI/CD Architecture

This project will also demonstrate a complete DevOps pipeline.

```text
Developer
    │
    ▼
GitHub
    │
    ▼
CI Pipeline
    │
    ├── Code Quality
    ├── Unit Tests
    ├── Security Scan
    └── Docker Build
             │
             ▼
          Amazon ECR
             │
             ▼
       CD Deployment
             │
             ▼
          Amazon EKS
             │
             ▼
       Rolling Update
             │
             ▼
        Production
```

We'll eventually implement things such as:

```text
Git
GitHub Actions
Docker
ECR
Terraform
Terragrunt
Helm
Kubernetes
EKS
```

---

# 1.8 Infrastructure as Code

We should **not manually create everything from the AWS Console**.

Terraform will create our infrastructure.

Example:

```text
Terraform
    │
    ├── VPC
    ├── Subnets
    ├── NAT Gateway
    ├── Security Groups
    ├── IAM
    ├── S3
    ├── RDS
    ├── EKS
    ├── CloudFront
    ├── Route 53
    └── WAF
```

And we'll use **Terragrunt** to manage environments.

```text
streamflix-infra/
│
├── live/
│   ├── dev/
│   ├── stage/
│   └── prod/
│
└── modules/
    ├── vpc/
    ├── eks/
    ├── rds/
    ├── s3/
    ├── cloudfront/
    ├── iam/
    └── monitoring/
```

---

# 1.9 Environments

We'll maintain three environments:

```text
                 StreamFlix
                     │
        ┌────────────┼────────────┐
        │            │            │
       DEV          STAGE        PROD
        │            │            │
     Testing      Validation    Users
```

Example AWS strategy:

```text
Development
   ↓
streamflix-dev

Staging
   ↓
streamflix-stage

Production
   ↓
streamflix-prod
```

This allows us to demonstrate proper DevOps promotion.

---

# 1.10 Security Architecture

Security will be integrated from the beginning.

```text
                     Users
                       │
                       ▼
                    WAF
                       │
                       ▼
                CloudFront
                       │
                       ▼
                    ALB
                       │
                       ▼
                     EKS
                       │
                ┌──────┴──────┐
                │             │
             Secrets        IAM
             Manager       Roles
                │             │
                └──────┬──────┘
                       ▼
                   Databases
```

We'll cover:

* IAM
* IAM Roles for Service Accounts / EKS Pod Identity concepts
* Security Groups
* Network ACLs
* KMS
* Secrets Manager
* WAF
* TLS certificates
* Private subnets
* Encryption at rest
* Encryption in transit
* Least privilege
* Container security

---

# 1.11 Monitoring Architecture

Eventually:

```text
                 Application
                      │
          ┌───────────┼───────────┐
          │           │           │
          ▼           ▼           ▼
      Metrics       Logs       Traces
          │           │           │
          └───────────┼───────────┘
                      ▼
                Observability
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
      CloudWatch            Prometheus
                                  │
                                  ▼
                              Grafana
```

We'll create alerts for things such as:

```text
High CPU
High Memory
Pod Crash
HTTP 5xx
High Latency
Database Connections
Disk Usage
Application Errors
```

---

# 1.12 Production Scaling

Imagine:

```text
Normal Traffic

        100 users
            │
            ▼
        EKS Pods
        2 replicas
```

Suddenly:

```text
New Movie Released

        100,000 users
              │
              ▼
           EKS
              │
       ┌──────┼──────┐
       ▼      ▼      ▼
      Pod    Pod    Pod
       │      │      │
       └──────┼──────┘
              │
             HPA
              │
       More replicas
```

We'll demonstrate:

* Kubernetes HPA
* Cluster scaling
* Karpenter concepts
* CloudFront caching
* Database scaling
* Redis caching
* Load balancing

---

# 1.13 Final Technology Stack

Our project will eventually use:

### ☁️ AWS

```text
Route 53
CloudFront
WAF
S3
EKS
ECR
ALB
VPC
IAM
KMS
Secrets Manager
RDS/Aurora
DynamoDB
ElastiCache
MediaConvert
CloudWatch
```

### 🐳 DevOps

```text
Git
GitHub
Docker
Terraform
Terragrunt
Helm
Kubernetes
GitHub Actions
```

### 💻 Application

```text
Frontend
React / Next.js

Backend
Node.js / Python

Database
PostgreSQL

Cache
Redis
```

---

# 1.14 What Students Will Learn

By completing this single project, students won't just learn individual AWS services.

They'll understand the **relationship between services**.

For example:

```text
User
 ↓
Route 53
 ↓
CloudFront
 ↓
WAF
 ↓
ALB
 ↓
EKS
 ↓
Application
 ↓
Redis
 ↓
RDS
```

And for video:

```text
Admin
 ↓
S3
 ↓
MediaConvert
 ↓
S3
 ↓
CloudFront
 ↓
User
```

And for deployment:

```text
Developer
 ↓
GitHub
 ↓
CI/CD
 ↓
Docker
 ↓
ECR
 ↓
EKS
 ↓
Production
```

---

# 🚀 How We'll Execute the Project

I recommend we **don't try to build everything at once**.

We'll follow this progression:

```text
PHASE 1
Architecture
     ↓
PHASE 2
Build Application
     ↓
PHASE 3
AWS Foundation
     ↓
PHASE 4
VPC / Networking
     ↓
PHASE 5
Terraform + Terragrunt
     ↓
PHASE 6
Database + Cache
     ↓
PHASE 7
Docker
     ↓
PHASE 8
EKS
     ↓
PHASE 9
CI/CD
     ↓
PHASE 10
Video Streaming
     ↓
PHASE 11
Security
     ↓
PHASE 12
Monitoring
     ↓
PHASE 13
Scaling
     ↓
PHASE 14
DR + Troubleshooting
     ↓
🎬 PRODUCTION-READY STREAMFLIX
```

