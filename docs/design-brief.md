# Manufacturing QMS Platform --- AI Coding Agent Design Brief

**Document purpose:** Product and technical implementation brief for an
AI coding agent working in the existing codebase.\
**Product direction:** Hybrid manufacturing QMS + connected quality
data/integration platform.\
**Initial market:** Manufacturing and engineering businesses.\
**Architecture target:** Multi-tenant, API-first, modular monolith with
an extensible connector framework.

------------------------------------------------------------------------

## 1. Mission and product vision

Build a manufacturing-focused Quality Management System (QMS) that can
operate as a company's primary quality system while also integrating
with its existing manufacturing and business infrastructure.

The product must serve two customer types:

1.  **QMS-first customers:** Smaller manufacturers that want to manage
    documents, non-conformances, corrective actions, audits, inspections
    and related quality processes in this application.
2.  **Connected-enterprise customers:** Manufacturers that already use
    ERP, MES, PLM, SQL databases, CMM software or bespoke applications
    and want to connect those systems to a central quality platform.

The core product principle is:

> The QMS owns quality processes and controlled quality records, but it
> does not need to own the original source of every piece of
> manufacturing data.

External systems may provide production orders, parts, serial numbers,
supplier data and inspection results. The QMS should normalise relevant
data into canonical internal models, link it to quality workflows, and
preserve source traceability.

Do not build a generic CRUD application or a document repository and
call it a QMS. Prioritise real manufacturing workflows, traceability,
controlled records and integrations.

## 2. Agent operating instructions

Before making changes:

1.  Inspect the existing repository, package manifests, framework
    versions, folder structure, database schema, migrations,
    authentication, deployment configuration and established coding
    conventions.
2.  Identify what already exists and what is missing. Do not assume the
    stack in this brief has already been adopted.
3.  Preserve working functionality. Do not replace existing
    infrastructure or perform broad rewrites without a demonstrated
    need.
4.  Produce a short implementation plan identifying affected files,
    schema changes, dependencies, risks and tests before substantial
    changes.
5.  Prefer incremental, reversible changes and database migrations.
    Never silently drop or rename production data.
6.  Reuse existing components, patterns and libraries where they are
    sound. If a recommendation in this brief conflicts with a
    well-established existing implementation, explain the trade-off and
    propose the least disruptive solution.
7.  Do not implement future phases prematurely. Establish foundations
    where necessary, but deliver complete, tested vertical slices.
8.  Never invent completed functionality, successful integrations, test
    results or security guarantees. Report what was actually implemented
    and verified.
9.  Keep secrets out of source control and client-side bundles.
10. Update relevant documentation, environment examples, migrations and
    tests with every feature.

**Important:** This brief defines product intent and target
architecture, not permission to rebuild the entire codebase. The
existing repository is the source of truth for its current state.

## 3. Architectural principles

### 3.1 Multi-tenant by design

One SaaS deployment serves multiple customer organisations with strict
logical data isolation.

-   Every tenant-owned business record must be associated with an
    `organisation_id`.
-   Users may belong to more than one organisation.
-   Users may have different roles and scopes in each organisation.
-   Support organisation-wide, site-scoped and, where needed,
    department-scoped access.
-   Enforce tenant isolation in backend services and database policies.
    Never rely on frontend filtering alone.
-   Test cross-tenant access through direct endpoints, nested
    relationships, search, exports, files and background jobs.

Use PostgreSQL Row Level Security (RLS) where appropriate, alongside
explicit backend authorisation. Establish a safe tenant context for
every request and worker operation.

### 3.2 Modular monolith first

Start with one deployable backend organised into independent business
modules. Do not introduce microservices, Kubernetes or Kafka without a
measured scaling or operational requirement.

Suggested backend domains:

-   Identity and access
-   Organisations and sites
-   Manufacturing master data
-   Non-conformance management
-   CAPA
-   Inspection and measurement
-   Document control
-   Audits
-   Supplier quality
-   Calibration and equipment
-   Training and competency
-   Workflows and notifications
-   Integrations
-   Reporting and audit history

Each module owns its business rules and exposes application services.
Controllers should remain thin. Connectors must call application
services rather than write directly to QMS business tables.

### 3.3 API-first

All important business operations should be available through
documented, versioned APIs. The frontend is one API consumer;
integrations and future third-party developers are other consumers.

-   Use versioned REST endpoints, initially `/api/v1`.
-   Publish OpenAPI documentation.
-   Use stable UUIDs for internal identifiers.
-   Use idempotency for create/import operations where duplicates are
    possible.
-   Apply authentication, permissions, validation, rate limits and audit
    logging consistently.
-   Keep public API contracts separate from internal database
    implementation details.

### 3.4 Canonical data model

External systems have different names and structures for equivalent
information. Convert incoming data into canonical QMS/manufacturing
models before it enters business workflows.

Examples of canonical entities:

-   Part and part revision
-   Product and bill of materials
-   Customer and supplier
-   Production order and operation
-   Lot/batch and serial number
-   Equipment
-   Inspection plan, characteristic and result
-   Non-conformance and corrective action

Do not create an entirely generic entity/field/value database. Use
relational tables for core business entities and JSONB only for
genuinely variable metadata, provider payloads and configurable
extensions.

Preserve the original source payload or a suitable immutable reference
to it, along with source system, connection, external ID, import time
and transformation version.

### 3.5 Quality data integrity

Quality-critical records need controlled lifecycle and history.

-   Do not overwrite approved document revisions.
-   Preserve approval and revision history.
-   Preserve changes to quality-critical fields.
-   Record who did what, when, why and from which source.
-   Keep audit history separate from ordinary activity feeds.
-   Use explicit status transitions and server-side validation.
-   Do not treat a simple username/timestamp as a compliant electronic
    signature.
-   Do not claim that software alone makes a customer ISO 9001
    compliant.

------------------------------------------------------------------------

## 4. Target technology direction

Use these as preferred choices when starting new components, subject to
repository inspection:

  -----------------------------------------------------------------------
  Layer                               Preferred direction
  ----------------------------------- -----------------------------------
  Frontend                            Next.js + React + TypeScript

  UI                                  Tailwind CSS + shadcn/ui or
                                      equivalent existing component
                                      system

  Forms                               React Hook Form + Zod

  Server state                        TanStack Query

  Backend                             NestJS + TypeScript

  Database                            PostgreSQL

  ORM/query layer                     Drizzle ORM (or retain an
                                      established, suitable ORM)

  Authentication                      Managed auth such as Supabase Auth
                                      initially, if appropriate

  Authorisation                       Backend RBAC + tenant
                                      enforcement/RLS

  Jobs                                Redis + BullMQ for asynchronous
                                      work

  Files                               Private S3-compatible object
                                      storage

  API documentation                   OpenAPI/Swagger

  Monitoring                          Sentry + OpenTelemetry or
                                      equivalent

  Hosting                             Vercel for frontend; AWS or
                                      equivalent managed infrastructure
                                      for API, workers and data
  -----------------------------------------------------------------------

Do not add all these dependencies at once. Adopt them only when required
by the implementation stage. Avoid coupling business logic to a
particular hosting provider or managed auth vendor.

------------------------------------------------------------------------

## 5. Organisation and access model

Use the following conceptual hierarchy:

``` text
Organisation
  ├── Sites
  │    ├── Departments
  │    │    └── Production areas / teams
  │    └── Equipment and local operations
  └── Users and role assignments
```

Core tables:

-   `organisations`
-   `sites`
-   `departments`
-   `production_areas`
-   `users` (or managed auth identities plus application profile)
-   `organisation_users`
-   `roles`
-   `permissions`
-   `role_permissions`
-   `user_role_assignments`
-   `organisation_settings`

A user can belong to multiple organisations. Role assignments should
support optional site and department scope. Include membership status
and invitation lifecycle.

Use a consistent tenant-owned record convention, typically:

``` text
id UUID PRIMARY KEY
organisation_id UUID NOT NULL
created_at
created_by
updated_at
updated_by
```

Add version numbers, status and other controls where the domain requires
them. Use tenant-scoped unique constraints,
e.g. `(organisation_id, reference)`.

------------------------------------------------------------------------

## 6. Functional product domains and data model

The following is the target domain model. Implement it incrementally; do
not create every table before the related workflow is understood.

### 6.1 Manufacturing master data and traceability

Tables/entities:

-   `customers`
-   `suppliers`
-   `products`
-   `parts`
-   `part_revisions`
-   `product_bom`
-   `production_orders`
-   `production_operations`
-   `lots`
-   `serial_numbers`
-   `equipment`
-   `processes`

Relationships should allow a quality record to trace to a customer,
product, part, applicable drawing/specification revision, production
order, operation, lot/batch, serial number and equipment where relevant.

Avoid duplicating master data unnecessarily. Decide which system owns
each field and preserve external references.

### 6.2 Non-conformance management (NCR)

Suggested entities:

-   `nonconformances`
-   `ncr_classifications`
-   `ncr_sources`
-   `ncr_containments`
-   `ncr_investigations`
-   `ncr_dispositions`
-   `ncr_affected_items`
-   `ncr_links`
-   `ncr_comments`

An NCR should support:

-   Reference, date, source, severity and status
-   Description of the non-conformance
-   Requirement/specification and actual result
-   Affected part, revision, order, operation, lot and serial number
-   Evidence and attachments
-   Immediate containment
-   Investigation and root cause
-   Disposition (e.g. rework, repair, scrap, concession)
-   Corrective action links
-   Verification and closure approvals
-   Complete history

Do not require all fields at initial creation. Requirements should
depend on controlled workflow stage and organisation configuration.

### 6.3 Corrective and preventive action (CAPA)

Suggested entities:

-   `capas`
-   `capa_sources`
-   `capa_root_causes`
-   `capa_actions`
-   `capa_action_owners`
-   `capa_verifications`
-   `capa_links`

CAPA is its own domain. Support one CAPA addressing multiple NCRs and
one NCR linking to multiple actions where appropriate. Model
relationships explicitly rather than assuming one-to-one relationships.

### 6.4 Inspection and measurement

Suggested entities:

-   `inspection_plans`
-   `inspection_plan_revisions`
-   `inspection_characteristics`
-   `inspection_lots`
-   `inspection_results`
-   `measurement_devices`
-   `measurement_attachments`
-   `inspection_sampling_rules`

Support nominal values, upper/lower tolerances, units, method,
applicable specification/plan revision, actual result, device, operator,
timestamp, source and evidence.

Use an appropriate precise numeric representation (e.g. PostgreSQL
`NUMERIC`) for measurements. Store units explicitly. Never silently
compare different units. Unit conversions must be explicit, tested and
traceable.

A failed inspection may trigger an NCR workflow, but this must be
configurable. Some organisations may require remeasurement or review
before NCR creation.

### 6.5 Document control

Suggested entities:

-   `documents`
-   `document_revisions`
-   `document_files`
-   `document_approvals`
-   `document_distribution`
-   `document_acknowledgements`
-   `document_categories`

Separate document identity from revision. Approved revisions must be
immutable; a change creates a new revision. Support review, approval,
effective date, supersession, access control and controlled
distribution.

### 6.6 Audits

Suggested entities:

-   `audit_programmes`
-   `audits`
-   `audit_checklists`
-   `audit_questions`
-   `audit_responses`
-   `audit_findings`
-   `audit_actions`

Support audit schedules/programmes, checklists, findings, evidence,
owners, actions and links to NCR/CAPA records.

### 6.7 Additional quality domains

Add incrementally:

-   Supplier quality and supplier performance
-   Calibration and equipment management
-   Training and competency matrices
-   Risk management
-   Management review and quality KPIs

------------------------------------------------------------------------

## 7. Integration platform

Integrations are a core architectural capability, not a late add-on. The
integration layer must be isolated from QMS business logic.

### 7.1 Initial integration capabilities

Plan for three connection patterns:

1.  **Direct API:** Connect to external REST or other supported APIs.
2.  **Local connector agent:** A customer-installed service inside its
    network, making outbound encrypted connections to the cloud QMS and
    reading explicitly approved internal sources.
3.  **File-based:** CSV, XLSX and XML import/export, including scheduled
    file ingestion where appropriate.

For manufacturing customers, the local agent is important because
internal ERP/SQL/CMM systems may not be exposed publicly. Make it
read-only by default.

### 7.2 Integration entities

Suggested tables:

-   `integration_providers`
-   `integration_connections`
-   `integration_credentials` (store secret references, not plaintext
    secrets)
-   `integration_entities`
-   `integration_field_mappings`
-   `integration_sync_jobs`
-   `integration_sync_runs`
-   `integration_sync_cursors`
-   `integration_external_records`
-   `integration_inbox`
-   `integration_outbox`
-   `integration_errors`
-   `integration_webhook_subscriptions`
-   `integration_webhook_deliveries`

External record mapping must link an internal record to its source
connection and external identifier. Enforce uniqueness across
organisation, connection, entity type and external ID.

Example:

``` text
integration_external_records
  organisation_id
  connection_id
  entity_type
  external_id
  internal_id
  last_synced_at
```

Do not use external IDs as internal primary keys.

### 7.3 Connector contract

Create a provider adapter interface with capabilities such as:

``` typescript
interface ConnectorAdapter {
  getMetadata(): ConnectorMetadata;
  testConnection(): Promise<ConnectionTestResult>;
  discoverEntities(): Promise<ExternalEntity[]>;
  fetchRecords(entity: string, cursor?: string): Promise<FetchResult>;
  subscribeToEvents?(config: WebhookConfig): Promise<void>;
  pushRecord?(entity: string, record: unknown): Promise<PushResult>;
}
```

The exact interface should reflect actual connector requirements and
support capability discovery. Not every connector supports webhooks,
write-back or incremental cursors.

Suggested structure:

``` text
integrations/
  core/
    connector.interface.ts
    connector.registry.ts
    sync.engine.ts
    mapping.engine.ts
    validation.engine.ts
  providers/
    rest-api/
    csv/
    sql-server/
    sap/
    microsoft-dynamics/
    pc-dmis/
  workers/
    sync.worker.ts
    import.worker.ts
    webhook.worker.ts
```

Build the generic REST connector and CSV importer before bespoke
provider connectors. Treat SAP, Dynamics and PC-DMIS as future provider
integrations, not as already supported features.

### 7.4 Integration processing pipeline

Use this pipeline:

``` text
External system
  -> Connector adapter
  -> Ingestion/staging
  -> Field mapping and transformation
  -> Validation
  -> Canonical model
  -> QMS application service
  -> Main QMS database
  -> Domain event / outbound integration
```

Requirements:

-   Validate before writing business records.
-   Keep failed records visible and retryable.
-   Use idempotency and external record mapping to prevent duplicates.
-   Support incremental cursors where provider capabilities allow.
-   Handle rate limits, pagination, retries and backoff.
-   Record mapping version and processing result.
-   Support preview/dry-run before activating imports.
-   Preserve source provenance and original payload/reference.
-   Do not allow a connector to bypass approvals or workflow validation.
-   Do not silently overwrite QMS-owned fields.

### 7.5 Data ownership and conflict handling

Define field ownership/system of record per connection and entity.

Example:

  Data                         Possible owner
  ---------------------------- ----------------
  Production order number      ERP
  Part number                  ERP
  Drawing revision             QMS or PLM
  Inspection results           CMM or QMS
  NCR investigation            QMS
  Corrective action approval   QMS

Define conflict policies explicitly: source-wins, QMS-wins, manual
review or field-specific ownership. Do not assume bidirectional sync
means every field can be overwritten in either direction.

### 7.6 Local connector agent security

When implemented, the agent should:

-   Use outbound-only encrypted connections where possible.
-   Have a revocable, uniquely registered identity.
-   Use least-privilege database credentials.
-   Read only approved sources, tables, views or configured queries.
-   Never accept arbitrary SQL execution from the cloud.
-   Store local credentials securely.
-   Report agent version, health and sync status.
-   Support secure update and credential rotation.
-   Require explicit configuration for write-back.

------------------------------------------------------------------------

## 8. Events, workflows and background processing

Use internal domain events to decouple modules while retaining a modular
monolith.

Example: an inspection failure publishes `inspection.result.failed`. A
workflow can then decide whether to create an NCR, request
remeasurement, place affected items on hold, notify a quality manager or
send an event to an ERP.

Suggested tables:

-   `domain_events`
-   `outbox_events`
-   `inbox_events`
-   `workflow_definitions`
-   `workflow_versions`
-   `workflow_instances`
-   `workflow_tasks`
-   `notifications`

Use a transactional outbox pattern: write the business change and its
outbox event in the same database transaction, then process it
asynchronously. Make consumers idempotent.

Use PostgreSQL and a job queue (e.g. Redis/BullMQ) initially. Kafka is
not required at the outset.

Workflows must be configurable and versioned. A change to a workflow
must not silently alter the behaviour/history of already-running or
completed records. Define how active instances respond to a new version.

------------------------------------------------------------------------

## 9. Frontend information architecture

The application should feel like one coherent manufacturing quality
platform.

Suggested navigation:

**Workspace** - Overview - Non-conformances - CAPA - Inspection and
measurement - Document control - Audits - Supplier quality - Calibration
and equipment - Training and competency - Quality analytics

**Manufacturing** - Products and parts - Production orders -
Traceability

**Administration** - Integrations - Workflows - Users and permissions -
Sites and departments - Organisation settings

Provide organisation and site switching in the application shell.
Navigation and actions should respect permissions.

### Frontend structure

Prefer feature-based organisation:

``` text
app/
  (auth)/
  (application)/
    [organisationId]/
      overview/
      quality/
        ncrs/
        capa/
        inspections/
        audits/
        suppliers/
      documents/
      calibration/
      training/
      manufacturing/
        products/
        production-orders/
        traceability/
      settings/
        integrations/
        workflows/
        users/
        organisation/

features/
  ncrs/
  capa/
  inspections/
  documents/
  integrations/
  manufacturing/
  workflows/

components/
  layout/
  navigation/
  tables/
  forms/
  charts/
  ui/

lib/
  api-client/
  auth/
  permissions/
  query/
  validation/
```

Adapt route and folder conventions to the existing framework. Do not
duplicate the same component or API logic in multiple features.

### Reusable UI components

Build reusable patterns for:

-   Data tables with sorting, filtering, pagination and saved views
-   Status and severity badges
-   Record headers and detail layouts
-   Record timelines and activity feeds
-   Approval panels
-   User assignment
-   Attachments and evidence
-   Audit history
-   Search and filter builders
-   Empty, loading and error states

An NCR detail view should have tabs for overview, containment,
investigation, disposition, corrective actions, evidence and history. A
contextual panel should show related part, revision, production order,
serial/lot, supplier and inspection records.

### Integration UI

Create these areas:

1.  Connector catalogue
2.  Connections and credentials
3.  Entity selection and field mapping
4.  Sync schedules and run history
5.  Monitoring, rejected records and error resolution

Connection setup journey:

``` text
Select provider
 -> Configure credentials
 -> Test connection
 -> Discover entities
 -> Select data
 -> Map fields
 -> Preview and validate
 -> Activate sync
```

Do not expose secrets after initial entry. Show clear connection health,
last successful sync, sync frequency, records processed, rejected
records and actionable error details.

------------------------------------------------------------------------

## 10. API conventions

Use `/api/v1` and consistent resource conventions. Example endpoints:

``` text
/api/v1/organisations
/api/v1/sites
/api/v1/ncrs
/api/v1/ncrs/:id
/api/v1/ncrs/:id/containment
/api/v1/capas
/api/v1/inspections
/api/v1/inspection-results
/api/v1/parts
/api/v1/production-orders
/api/v1/serial-numbers
/api/v1/documents
/api/v1/audits
/api/v1/integrations
/api/v1/integrations/:id/sync
/api/v1/integrations/:id/runs
```

Every endpoint must enforce tenant membership, permission scope,
validation and audit requirements. Use consistent pagination, filtering,
error formats and request correlation IDs.

Plan for machine-to-machine credentials, OAuth2 client credentials where
appropriate, API scopes, token revocation, webhook signing, rate limits
and idempotency keys. Do not expose internal database rows as public API
contracts.

------------------------------------------------------------------------

## 11. Security, auditability and operational requirements

Minimum requirements:

-   Tenant isolation at backend and database layers.
-   Secure authentication and MFA support.
-   Role- and scope-based authorisation.
-   Private object storage and short-lived signed file access.
-   Encrypted secrets management.
-   API rate limiting and input validation.
-   Revocable integration credentials.
-   Append-only quality audit events.
-   Automated backups and tested restore procedures.
-   Error monitoring and structured logs.
-   Data retention and export controls.
-   Secure handling of customer confidential data.

Audit event fields should include, as appropriate:

``` text
id
organisation_id
actor_user_id
entity_type
entity_id
action
previous_values
new_values
reason
source
correlation_id
created_at
```

Distinguish system activity logs from formal quality audit trails.
Restrict modification/deletion of quality audit events. For
high-assurance requirements, consider stronger tamper-evidence and
retention controls.

------------------------------------------------------------------------

## 12. Delivery roadmap and priorities

Deliver complete vertical slices. Do not build the entire target schema
or every module in one pass.

### Phase 0 --- Repository assessment and architecture alignment

-   Inspect the codebase and report current architecture.
-   Identify existing reusable functionality.
-   Map current database entities and migrations to the target domains.
-   Identify security, tenancy and audit gaps.
-   Propose incremental migrations and implementation order.

**Exit criteria:** An agreed implementation plan that preserves existing
functionality and identifies the first vertical slice.

### Phase 1 --- Platform foundation

-   Application shell and organisation context.
-   Organisation/site hierarchy.
-   User membership and roles.
-   Tenant isolation and permissions.
-   Database migration conventions.
-   Audit event infrastructure.
-   API conventions and OpenAPI.
-   Shared UI and API client patterns.

**Exit criteria:** A user can securely work within an organisation and
cannot access another tenant's data.

### Phase 2 --- First complete QMS workflow

-   Parts and part revisions.
-   Inspection plans and characteristics.
-   Manual inspection result entry.
-   NCR register and detail.
-   Containment and investigation.
-   Root cause and disposition.
-   Corrective actions.
-   Verification, approval and closure.
-   Evidence and history.

**Exit criteria:** A user can complete an end-to-end inspection failure
→ NCR → investigation → corrective action → effectiveness verification
workflow with traceability and audit history.

### Phase 3 --- Manufacturing traceability

-   Production orders.
-   Operations.
-   Lots and serial numbers.
-   Product/customer links.
-   Equipment links.
-   Traceability views and relationships.

**Exit criteria:** A quality record can be traced to the relevant
manufacturing context without relying on free-text references alone.

### Phase 4 --- Broader QMS modules

-   Document control and revision approvals.
-   Audits and findings.
-   Supplier quality.
-   Calibration.
-   Training and competency.
-   Risk and management review.

**Exit criteria:** Additional modules use consistent permissions,
workflow, audit and record-linking patterns.

### Phase 5 --- Integration foundation

-   Provider/connector registry.
-   Connection management.
-   External record mapping.
-   Canonical production order/part models.
-   Generic REST connector.
-   CSV/XLSX import.
-   Field mapping and validation.
-   Background sync jobs.
-   Sync history and error monitoring.
-   Preview/dry-run.

**Exit criteria:** A customer can safely import a supported external
dataset, map it to canonical records, preview it and synchronise without
duplicates.

### Phase 6 --- Advanced manufacturing integrations

-   Local SQL connector agent.
-   SQL Server support.
-   Selected ERP integrations (e.g. SAP, Dynamics).
-   CMM/inspection data ingestion.
-   Webhooks and controlled write-back.
-   Conflict resolution and field ownership.

**Exit criteria:** At least one real customer integration works reliably
in a representative environment with documented security and recovery
behaviour.

### Phase 7 --- Enterprise readiness and ecosystem

-   SSO and enterprise identity.
-   Advanced multi-site permissions.
-   Custom workflows and reporting.
-   Dedicated deployment options where commercially justified.
-   Public API and developer documentation.
-   Connector SDK and third-party registration.

**Exit criteria:** The platform can be operated and extended by
enterprise customers and approved integration partners.

------------------------------------------------------------------------

## 13. First implementation backlog

The first coding milestone should be a repository-aware plan, followed
by these workstreams.

### Foundation

-   [ ] Inspect existing codebase and document current architecture.
-   [ ] Establish or confirm frontend/backend project structure.
-   [ ] Establish PostgreSQL migration and schema conventions.
-   [ ] Implement organisation and site model.
-   [ ] Implement user membership and organisation context.
-   [ ] Implement roles, permissions and scoped assignments.
-   [ ] Enforce tenant isolation and test it.
-   [ ] Establish audit event infrastructure.

### First manufacturing workflow

-   [ ] Parts and revisions.
-   [ ] Inspection plans.
-   [ ] Inspection characteristics and units.
-   [ ] Manual inspection results.
-   [ ] NCR register and detail.
-   [ ] Containment and investigation.
-   [ ] Disposition and affected items.
-   [ ] Corrective actions.
-   [ ] Effectiveness verification and closure.
-   [ ] Linked record history and evidence.

### Integration foundations

-   [ ] Connector registry and provider metadata.
-   [ ] Integration connections and secure credential references.
-   [ ] External record mapping.
-   [ ] Canonical production order/part model.
-   [ ] Generic REST connector.
-   [ ] CSV import and staging pipeline.
-   [ ] Mapping, validation and preview.
-   [ ] Idempotent sync jobs and monitoring.

------------------------------------------------------------------------

## 14. Definition of done

A feature is not complete merely because its UI renders.

For each feature, verify:

1.  Database schema and migration are present and reversible where
    practical.
2.  Backend business rules and validation are implemented.
3.  Tenant isolation and permissions are enforced server-side.
4.  Frontend loading, empty, error and success states are handled.
5.  Quality-critical changes create appropriate audit events.
6.  Relationships and record history are preserved.
7.  Automated tests cover core behaviour and important failure cases.
8.  API documentation and relevant technical documentation are updated.
9.  No secrets or sensitive data are exposed in logs or client bundles.
10. The implementation has been tested in the actual repository
    environment.

For integrations additionally verify:

-   Repeated imports do not create duplicates.
-   Failed records can be inspected and retried safely.
-   Mapping errors are actionable.
-   Sync cursors and pagination work correctly.
-   Credentials can be revoked/rotated.
-   External writes cannot bypass QMS business rules.
-   Source provenance is retained.
-   Conflict behaviour is explicit and tested.

For multi-tenancy additionally verify direct, indirect, search, file,
export and background-job access boundaries.

------------------------------------------------------------------------

## 15. Explicit non-goals for the initial release

Do not spend early development effort on:

-   Microservices.
-   Kubernetes.
-   Kafka.
-   A universal arbitrary entity/field/value database.
-   A large public connector marketplace.
-   Bespoke SAP or Dynamics connectors before the generic integration
    framework is proven.
-   AI root-cause automation before the underlying data and workflows
    are reliable.
-   A full on-premise deployment model before a customer requires it.
-   Bidirectional synchronisation of every field by default.

These may become relevant later, but they are not prerequisites for a
credible first product.

## 16. Product success criteria

The first meaningful product milestone is not the number of modules. It
is proving this complete use case:

1.  A manufacturer registers a part and revision.
2.  An inspection plan defines measurable characteristics and
    tolerances.
3.  An operator records an inspection result.
4.  A failed result is linked to the correct part and specification
    revision.
5.  An NCR is raised and contained.
6.  Quality investigates and records root cause/disposition.
7.  Corrective actions are assigned and completed.
8.  Effectiveness is verified and the NCR is formally closed.
9.  The complete history is traceable.
10. Later, the same inspection result can be imported from an external
    CMM or manufacturing system through a connector without changing the
    QMS workflow.

**Final instruction to the coding agent:** Build the platform
incrementally around this workflow. Keep the architecture modular,
tenant-safe, API-first and integration-ready. Inspect before changing,
preserve existing working code, and prefer tested end-to-end
functionality over broad but incomplete scaffolding.
