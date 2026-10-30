// Common tech terms for cloud speech's custom vocabulary (architecture.md revision 7 S5).
// A term from the resume or job description is kept when it's in this list, even if it
// isn't capitalised. Our own list; extend freely.
export const TECH_TERMS = `
ASP.NET Core|.NET|C#|F#|C++|Java|Kotlin|Scala|Go|Golang|Rust|Python|Ruby|PHP|Swift|Objective-C|TypeScript|JavaScript|Node.js|Deno|Bun
React|Next.js|Angular|Vue|Svelte|Redux|Tailwind|Webpack|Vite|Blazor|Razor|MAUI|WPF|WinForms|Xamarin|Flutter|Dart|SwiftUI|Jetpack Compose
Spring Boot|Django|Flask|FastAPI|Express|NestJS|Rails|Laravel|gRPC|GraphQL|REST|OpenAPI|Swagger|SignalR|WebSocket|OAuth|OpenID Connect|JWT|SAML
SQL|NoSQL|PostgreSQL|Postgres|MySQL|SQL Server|SQLite|Oracle|MongoDB|Cassandra|DynamoDB|Cosmos DB|Redis|Memcached|Elasticsearch|OpenSearch|Snowflake|BigQuery|Redshift|Databricks
Entity Framework Core|Entity Framework|EF Core|Dapper|Hibernate|LINQ|ORM|ADO.NET|stored procedure|indexing|sharding|replication|partitioning|normalization|ACID|CAP theorem|eventual consistency
Kafka|RabbitMQ|Service Bus|Event Hubs|Event Grid|SQS|SNS|Kinesis|Pub/Sub|MassTransit|NServiceBus|Celery|message queue|event sourcing|CQRS|saga
Docker|Kubernetes|Helm|Terraform|Bicep|ARM template|Ansible|Pulumi|Jenkins|GitHub Actions|Azure DevOps|GitLab CI|ArgoCD|CI/CD|DevOps|SRE
Azure|AWS|GCP|Azure Functions|App Service|AKS|EKS|GKE|Lambda|EC2|S3|CloudFront|CloudWatch|Application Insights|Key Vault|Cosmos|Blob Storage|API Gateway|Cognito
microservices|monolith|serverless|load balancer|reverse proxy|NGINX|CDN|caching|rate limiter|circuit breaker|retry policy|Polly|idempotency|backpressure|throttling
async|await|Task|IAsyncEnumerable|IEnumerable|IQueryable|dependency injection|middleware|garbage collection|multithreading|concurrency|deadlock|mutex|semaphore|thread pool
SOLID|DRY|KISS|YAGNI|design patterns|singleton|factory|repository pattern|unit of work|observer|strategy|decorator|adapter|clean architecture|DDD|TDD|BDD
xUnit|NUnit|MSTest|Moq|JUnit|Jest|Vitest|Playwright|Cypress|Selenium|Postman|SonarQube|code coverage|integration test|unit test|load test|JMeter|k6
Big O|O(n)|O(log n)|O(1)|binary search|hash map|hash table|linked list|binary tree|BST|heap|trie|graph|BFS|DFS|Dijkstra|dynamic programming|recursion|memoization|sliding window|two pointers|LRU cache
machine learning|LLM|RAG|embeddings|vector database|PyTorch|TensorFlow|CUDA|TensorRT|NumPy|Pandas|Spark|Hadoop|Airflow|dbt|ETL|ELT|data pipeline|Power BI|Tableau
Agile|Scrum|Kanban|sprint|stand-up|retrospective|Jira|Confluence|pull request|code review|Git|GitHub|Bitbucket|monorepo|feature flag|A/B test|SLA|SLO|KPI|OKR
Linux|Windows Server|PowerShell|Bash|TCP/IP|HTTP|HTTPS|TLS|DNS|VPN|OWASP|XSS|CSRF|SQL injection|encryption|hashing|RBAC|Zero Trust|PCI DSS|GDPR|SOC 2|HIPAA
`
  .split(/[|\n]/)
  .map((t) => t.trim())
  .filter(Boolean)

/** How people say terms that are written differently ("sounds like" entries). */
export const SAYINGS: Record<string, string[]> = {
  'C#': ['C sharp'],
  'F#': ['F sharp'],
  'C++': ['C plus plus'],
  '.NET': ['dot net'],
  'ASP.NET Core': ['A S P dot net core', 'asp dot net core'],
  'ADO.NET': ['A D O dot net'],
  'Node.js': ['node J S', 'node'],
  'Next.js': ['next J S'],
  'EF Core': ['E F core'],
  'SQL': ['sequel', 'S Q L'],
  'SQL Server': ['sequel server'],
  'PostgreSQL': ['postgres', 'postgres Q L'],
  'MySQL': ['my sequel', 'my S Q L'],
  'NoSQL': ['no sequel', 'no S Q L'],
  'Kubernetes': ['kube', 'K eights', 'kubernetes'],
  'CI/CD': ['C I C D'],
  'TCP/IP': ['T C P I P'],
  'Pub/Sub': ['pub sub'],
  'A/B test': ['A B test'],
  'O(n)': ['O of N', 'big O of N'],
  'O(log n)': ['O of log N'],
  'O(1)': ['O of one', 'constant time'],
  'IAsyncEnumerable': ['I async enumerable'],
  'IEnumerable': ['I enumerable'],
  'IQueryable': ['I queryable'],
  'LINQ': ['link'],
  'JWT': ['J W T', 'jot'],
  'NGINX': ['engine X'],
  'GraphQL': ['graph Q L'],
  'gRPC': ['G R P C'],
  'OAuth': ['O auth'],
  'SOC 2': ['sock two', 'S O C two'],
}
