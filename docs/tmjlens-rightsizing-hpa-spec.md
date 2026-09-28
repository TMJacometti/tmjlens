# tmjLens — Módulo Rightsizing, HPA & Nodes

Especificação para implementação. Leia tudo antes de escrever código.

## 0. Como trabalhar neste projeto

1. **Explore o repositório antes de propor qualquer coisa.** Trabalhe na branch `WEB` (a versão web, instalada via Helm). Identifique a estrutura de crates/módulos, como o login/SSO e os perfis (Admin/Developer/Guest) funcionam, como o tmjLite é usado e como o chart Helm está organizado. **Siga as convenções existentes**; onde esta spec conflitar com o código real, pare e me pergunte.
2. Entregue por fases (seção 12), uma de cada vez, com testes. Não adiante fases futuras.
3. Tudo que estiver marcado como **[VERIFICAR]** é uma suposição que precisa ser confirmada empiricamente (docs oficiais ou cluster real) antes de virar decisão no código.
4. Código em Rust. Licença do projeto: AGPL-3.0.

## 1. Contexto e objetivo

O tmjLens é um console de operações Kubernetes (Rust; roda dentro do cluster via Helm; usuários, perfis e auditoria no tmjLite, num PVC). Este módulo adiciona um produto no estilo ScaleOps dentro dele:

- **Coletar** uso real de CPU e memória por container ao longo do tempo, com coletor próprio.
- **Comparar** com requests/limits e **reportar desperdício** (em recursos e em dinheiro).
- **Recomendar** requests e parâmetros de HPA.
- **Criar/editar/remover HPAs** direto no cluster, por uma interface, restrito ao perfil **Admin**.
- **Propor redução e troca de tipo de nós** (simulação de empacotamento + custo), e, numa fase posterior e opt-in, aplicar (seção 8b).
- Futuramente: automação de mudança de requests (fora do escopo agora).

Alvos: **AKS e EKS**. O mesmo núcleo deve servir aos dois.

## 2. Decisões já tomadas (não reabrir)

- **Sem Prometheus.** Coletor próprio. Nenhuma dependência de Prometheus, nem como fallback.
- **Sem versão desktop.** Apenas a versão web/in-cluster.
- **Deploy direto de HPA no cluster**, e **somente para o perfil Admin**. Developer e Guest não veem a funcionalidade.
- **Permissão de escrita (MVP): um único ServiceAccount**, o do pod do tmjLens. A Role de escrita em `horizontalpodautoscalers` só é criada quando `hpaManager.enabled=true`. Desligado por padrão: o chart continua somente leitura.
- **Armazenamento no tmjLite.** O PVC passa a ter tamanho configurável.
- **Núcleo agnóstico de nuvem**, com adaptadores só onde for inevitável (preço do nó).
- **Nós: primeiro só proposta (somente leitura), depois aplicação.** A aplicação (Fase 4b) é opt-in, desligada por padrão, usa **identidade de nuvem separada** e roda em **Deployment separado** do pod web (credencial de nuvem nunca fica no pod do tmjLens web).

## 3. Escopo

**Dentro (MVP):**
- Agente coletor (DaemonSet) + central.
- Rollups, histograma por container, relatório de desperdício.
- Recomendações de requests e sugestão de HPA.
- HPA Manager: formulário, preview com diff, aplicar, desfazer, auditoria.
- Values e RBAC no Helm.
- OIDC genérico além do Azure AD (ver seção 10).
- **Node Optimizer, Fase 4a:** proposta de redução/troca de nós, somente leitura (seção 8b).

**Fora (por enquanto):**
- Alteração automática de requests/limits (rightsizing ativo).
- Aplicação automática em nós (Fase 4b): documentada em 8b, mas só implementar depois da 4a validada e com pedido explícito.
- Gestão ativa de spot/Karpenter (a 4a apenas lê e diagnostica).
- KEDA, métricas custom/externas no HPA.
- Multi-cluster / SaaS multi-cliente.
- Exportar YAML/PR para GitOps (pode entrar depois; ver 8.6).

## 4. Arquitetura

```
[nó] agente (DaemonSet)  --rollups 5min-->  [central] (Deployment, 1 réplica) --> tmjLite (PVC)
   lê kubelet /metrics/cadvisor                 |  lê API do K8s (pods, workloads, HPAs)
                                                |  gera recomendações
                                                +-> UI web (tmjLens) --> aplica HPA (Admin)
```

- **Agente:** leve, em Rust, um por nó. Só leitura. Lê o kubelet do próprio nó.
- **Central:** recebe rollups, funde janelas maiores, grava no tmjLite, correlaciona pods com workloads pela API do Kubernetes, calcula recomendações e expõe a API usada pela UI.
- **Identidade do histórico: `namespace + kind + workload + container`**, nunca o nome do pod (pods são efêmeros).
- Central com **uma réplica** (sessão em memória do processo, como já é hoje).

## 5. Coleta

### 5.1 Fontes
- **Kubelet `/metrics/cadvisor`** do próprio nó (porta 10250, token do ServiceAccount): CPU (`container_cpu_usage_seconds_total`), memória (`container_memory_working_set_bytes`), throttling (`container_cpu_cfs_throttled_periods_total` / `container_cpu_cfs_periods_total`). Formato texto de exposição do Prometheus: escreva um parser simples, sem servidor Prometheus.
- **API do Kubernetes:** requests, limits, dono do pod (ReplicaSet → Deployment, StatefulSet, DaemonSet), `lastState.terminated.reason == OOMKilled`, número de réplicas ao longo do tempo.
- **[VERIFICAR]** RBAC exato para ler `/metrics/cadvisor` (`nodes/metrics`); evitar `nodes/proxy`. Validar em AKS e EKS.
- **[VERIFICAR]** certificado do kubelet costuma ser autoassinado: suportar CA configurável e, como opção explícita, `insecureSkipVerify` (padrão: verificar).
- **[VERIFICAR]** intervalo de atualização do cAdvisor (~10–15 s). Não amostrar mais rápido que isso.

### 5.2 Cálculos
- **CPU:** taxa = Δ(contador de uso) / Δt entre duas leituras. Tratar **reset do contador** (container reiniciou): se o valor cair, descartar o delta daquela amostra.
- **Memória:** working set (é o que o OOM killer usa). Guardar **máximo** por janela, além da distribuição.
- **Intervalo de amostragem:** 30 s (configurável). **Janela de rollup:** 5 min (configurável).
- **Distribuição:** histograma em **escala logarítmica** (buckets com fator de crescimento fixo, ex.: ~5%), por container e por janela, para CPU e memória. **Percentis não se somam:** a fusão é somar as contagens dos buckets, e o p95/p99 de 7/14/30 dias é calculado sobre o histograma fundido. Documente o erro relativo máximo do bucketing.
- **Buffer offline:** se o central estiver indisponível, o agente guarda os rollups em disco (limite de tamanho) e reenvia. Sem perda silenciosa.

### 5.3 Limitações a tratar explicitamente
- **Fargate (EKS) e virtual nodes (AKS):** DaemonSet não roda e o kubelet não é acessível. Fallback degradado via `metrics.k8s.io` (só CPU/memória instantâneos, sem throttling), sinalizado na UI como "dados limitados".
- **Cold start:** sem histórico no dia 1. Mostrar relatório desde o início com **confiança baixa**; recomendações só ganham confiança alta com dados suficientes (ver 7).
- Workloads efêmeros (Jobs curtos) não recebem recomendação.

## 6. Armazenamento (tmjLite)

Defina o schema real após ler como o tmjLens usa o tmjLite hoje. Entidades conceituais:

- **rollup_5m:** chave (workload+container, janela) → histograma CPU, histograma memória, máx. memória, contagem de amostras, OOMKills, razão de throttling, request/limit vigentes na janela, nº de réplicas.
- **rollup_1h / rollup_1d:** fusão dos anteriores (somando buckets).
- **recomendação:** workload+container, valores sugeridos, confiança, dias de dados, motivo (explicável), timestamp.
- **hpa_gerenciado:** HPA criado/editado pelo tmjLens (referência, versão aplicada).
- **auditoria:** quem (usuário da sessão), quando, ação, workload, YAML antes e depois, resultado.
- **snapshot_cluster:** foto periódica (ex.: horária) de nós e do agendamento (pod → nó, requests efetivos, restrições relevantes), base da simulação de nós.
- **proposta_nos:** node pool, nº de nós atual → proposto, tipo sugerido, $/mês estimado (ou vazio se sem preço), confiança, bloqueadores, premissas usadas.
- **Retenção (configurável):** bruto 48 h, rollups 90 d por padrão. Compactação/expurgo periódico.
- **[VERIFICAR]** como o tmjLite se comporta com escrita concorrente. Comece gravando **em lote por janela** (o gargalo conhecido é o fsync, não o volume). O volume é pequeno: agregado em janelas de 5 min, ~1 milhão de linhas/dia para ~2.000 containers.

## 7. Recomendações

Regras iniciais (parâmetros configuráveis; ajustar com dados reais):

- **Memória:** request ≈ pico (máx. do working set na janela analisada) + folga (padrão 15–20%). Nunca usar média. Se houve OOMKill recente, nunca recomendar redução.
- **CPU:** request ≈ p95 (ou p99) na janela + folga (padrão ~10%). Throttling relevante é sinal para **não** reduzir.
- **Confiança:** baixa (< 3 dias de dados), média (3–7), alta (≥ 7 dias com ciclo semanal desejável). Exibir na UI e no relatório.
- Toda recomendação carrega o **porquê** (números e janela usados). Sem caixa-preta.
- **Custo:** desperdício = (request − uso recomendado) convertido em $ pelo preço do nó ÷ vCPU e GiB. Preço via **adaptador por provedor**:
  - Azure: Retail Prices API. AWS: Price List API. Ambas públicas. Interface única "tipo de nó → $/h". **[VERIFICAR]** formatos e limites de cada API.
  - Usar o label do nó (`node.kubernetes.io/instance-type`) para achar o tipo. Se não houver preço, mostrar recursos sem $ (nunca inventar valor).
- Aviso obrigatório no relatório: reduzir requests **só reduz a fatura se os nós forem consolidados** pelo autoscaler.

## 8. HPA Manager

### 8.1 Fluxo da UI (somente Admin)
1. Escolher workload (Deployment ou StatefulSet).
2. Formulário: min/max réplicas, métrica (CPU como padrão), utilização alvo, `behavior` (janela de estabilização, políticas de subida/descida) — API `autoscaling/v2`.
3. **Sugestão automática** a partir do histórico: alvo de CPU a partir do p95 relativo ao request; max a partir do pico de réplicas observado com folga, limitado pelo teto configurável; min a partir do mínimo observado.
4. **Preview do YAML e diff** (server-side dry-run) antes de aplicar.
5. Aplicar → gravar auditoria → mostrar status (métricas atuais, réplicas desejadas/atuais, eventos/condições do HPA).
6. **Desfazer:** restaura a versão anterior ou remove o HPA, com auditoria.

### 8.2 Aplicação
- **Server-side apply** com field manager próprio (`tmjlens`); sem `force` por padrão.
- Marcar o HPA com label `app.kubernetes.io/managed-by: tmjlens` e annotation com prefixo próprio (definir o prefixo) indicando origem/versão.
- **HPA já existente no workload:** detectar. Se não é do tmjLens, oferecer editar/importar com confirmação explícita; **nunca** criar segundo HPA para o mesmo alvo.

### 8.3 Regras de segurança do HPA (bloquear ou avisar na UI)
- **Requests primeiro, HPA depois:** a utilização do HPA é `uso ÷ request`. Alterar requests muda o comportamento do HPA. Recalcular a sugestão sempre que os requests mudarem e avisar quando um HPA gerenciado ficar inconsistente com os requests atuais.
- **VPA/automação de requests + HPA na mesma métrica:** não permitir. Detectar VPA existente no workload e avisar.
- **Memória como métrica do HPA:** permitir, mas avisar que funciona mal (memória raramente cai após escalar). CPU é o padrão.
- **`metrics-server` ausente:** detectar e avisar/bloquear (o HPA não funciona sem ele).
- **Teto de réplicas:** `maxReplicasCeiling` configurável; alertar quando `max × request` do workload excede a capacidade do cluster (o tmjLens já calcula capacidade como o scheduler enxerga).
- **Detecção de GitOps (Argo/Flux):** por labels/annotations do workload. Modo configurável `gitopsGuard: warn | block | off`. Avisar que o sync pode reverter o HPA ou brigar pelo `spec.replicas` (mencionar `ignoreDifferences`).

### 8.4 Fora do MVP
- KEDA e métricas custom/externas.
- Se necessário depois: exportar YAML/PR para GitOps (8.6).

### 8.5 Estados de erro a cobrir
Conflito de apply, workload removido no meio do fluxo, HPA alterado por terceiro entre preview e aplicar (rejeitar e refazer o diff), permissão negada pelo cluster, timeout do dry-run.

### 8.6 Nota
Exportar YAML/PR ficou fora do MVP por decisão; não implementar sem pedido.

## 8b. Node Optimizer

### 8b.1 Fase 4a — Proposta (somente leitura)

Nenhuma permissão nova de escrita. Nenhuma credencial de nuvem.

**Entradas** (API do Kubernetes + rollups + recomendações da Fase 2): nós (alocável, labels, taints, tipo de instância, zona, node pool/group), pods (requests efetivos, nodeSelector, affinity, tolerations, topologySpread, owner), PDBs, PVCs/PVs (zona), DaemonSets (overhead por nó).

**Simulação de empacotamento:**
- Algoritmo inicial: first-fit decreasing em CPU e memória, sobre o **alocável** do nó menos o overhead dos DaemonSets.
- Restrições modeladas na v1: taints/tolerations, nodeSelector, nodeAffinity *required*, podAntiAffinity *required* e topologySpread com `DoNotSchedule` (incluindo espalhamento por zona), PDB (`minAvailable`/`maxUnavailable` → réplicas mínimas), limite de pods por nó, PVC preso a zona, recursos estendidos (ex.: GPU).
- **Restrição não modelada ⇒ workload "não movível"** (fica fixo na simulação) e aparece no relatório com o motivo. Nunca ignorar uma restrição em silêncio.
- **Folga para o pico:** usar `maxReplicas do HPA × request` (não a média), manter N+1 configurável e distribuição entre AZs.
- É uma **aproximação** do scheduler real. Ser conservador; nunca propor mais nós do que os atuais e chamar isso de economia.

**Cenários (lado a lado, por node pool):**
- **A. Só empacotar melhor:** requests atuais, menos nós.
- **B. Rightsizing + empacotar:** requests recomendados (usar só recomendações com confiança ≥ `minConfidence`), quantos nós sobram. É o cenário que converte a economia dos pods em fatura.
- **C. Troca de tipo/família de instância:** comparar a razão CPU:memória dos workloads com as famílias disponíveis e o preço (adaptador de preço da seção 7). **[VERIFICAR]** disponibilidade do tipo por região/zona. ARM/Graviton: sinalizar "requer validação de imagens" e **não** contar a economia por padrão.

**Saída por node pool:** nós atuais → propostos, $/mês estimado, confiança, premissas, e **principais bloqueadores** (PDB apertado, anti-afinidade, PVC zonal, requests inflados, pods sem controller). Sem preço disponível, mostrar só contagem de nós (nunca inventar $).

**Diagnóstico de "por que não consolida":** detectar o autoscaler de nós em uso (Karpenter, Cluster Autoscaler, Node Auto Provisioning do AKS) por CRDs/deployments, ler o que for possível da configuração e apontar o que impede a consolidação (ex.: annotations de "não disruptar/não evictar", PDBs, storage local, pods sem controller). **[VERIFICAR]** nomes atuais das annotations e do comportamento de consolidação de cada um.

### 8b.2 Fase 4b — Aplicação (opt-in, só depois da 4a validada)

**Não implementar sem pedido explícito.** Requisitos de desenho:

- Desligada por padrão (`nodeOptimizer.apply.enabled=false`); com ela desligada, nenhuma credencial de nuvem nem Role de escrita em nós é criada.
- **Componente separado** (Deployment `node-writer`), com **identidade de nuvem própria e mínima**: AKS via identidade gerenciada/Workload Identity; EKS via IRSA ou EKS Pod Identity. Escopo restrito aos node pools/groups listados explicitamente. **[VERIFICAR]** mecanismos e permissões mínimas em cada nuvem.
- Somente **Admin**, com preview e confirmação, **auditoria completa** e dry-run.
- **Preferir influenciar o autoscaler existente** (ajustar limites do pool) a terminar nós diretamente. Drenar/terminar nós direto só se não houver autoscaler, e com confirmação. **Decidir esta abordagem comigo antes de implementar a 4b.**
- Guardrails: máximo de nós (ou %) por execução, janela de manutenção configurável, cordon → drain respeitando PDBs, bloquear se o cluster não estiver saudável, botão de abortar e reverter (reescalar), sem executar em StatefulSets/PVC zonal sem checagem explícita.

## 9. Segurança, RBAC e Helm

- **Agente (DaemonSet):** leitura de `nodes/metrics` (e `nodes/stats` se necessário) para o kubelet. Sem `nodes/proxy`.
- **Central (leitura):** `get/list/watch` em pods, nodes, deployments, statefulsets, daemonsets, replicasets, horizontalpodautoscalers, poddisruptionbudgets, persistentvolumeclaims, persistentvolumes, storageclasses, e leitura de eventos; leitura das CRDs do autoscaler de nós, se existirem.
- **Escrita (apenas com `hpaManager.enabled=true`):** **Role por namespace** (lista explícita em `hpaManager.namespaces`) com `create/update/patch/delete/get/list/watch` em `horizontalpodautoscalers`. ClusterRole só como exceção, com confirmação explícita no install.
- **Agente → central:** autenticação obrigatória (segredo gerado pelo chart ou validação de token do ServiceAccount) + NetworkPolicy opcional. Decida a abordagem mais simples e segura após ler o chart, e me explique a escolha.
- O agente e o central **nunca** têm permissão de escrita fora da Role do HPA Manager.
- **Nós (4b):** a escrita em nós/node pools acontece só no `node-writer`, com identidade de nuvem própria (seção 8b.2). O pod web nunca recebe credencial de nuvem.

Values propostos (ajuste aos nomes/convenções do chart existente):

```yaml
collector:
  enabled: true
  interval: 30s          # leitura do kubelet
  window: 5m             # rollup enviado ao central
  retention:
    raw: 48h
    rollup: 90d
  kubelet:
    caFile: ""           # CA para verificar o kubelet
    insecureSkipVerify: false

persistence:
  size: 10Gi             # antes 1Gi; configurável

hpaManager:
  enabled: false         # desligado: nenhuma permissão de escrita é criada
  namespaces: []         # Role por namespace
  maxReplicasCeiling: 50
  gitopsGuard: warn      # warn | block | off

pricing:
  provider: auto         # auto | azure | aws | none

nodeOptimizer:
  enabled: true          # proposta (4a), somente leitura
  minConfidence: medium  # recomendações usadas no cenário B
  headroom:
    spareNodes: 1        # N+1
    zoneSpread: true
  apply:
    enabled: false       # 4b: desligada por padrão
    pools: []            # node pools/groups permitidos
    maxNodesPerRun: 1
    maintenanceWindow: ""
```

## 10. Autenticação e perfis

- **Somente Admin** acessa as telas e endpoints de HPA Manager. **O backend valida o perfil da sessão em toda requisição de escrita**; o perfil nunca vem de parâmetro do cliente. Esconder o botão não conta como controle.
- Como a escrita usa o ServiceAccount do pod, o RBAC do cluster **não distingue o usuário**. Por isso a **auditoria** (usuário da sessão, YAML antes/depois) é obrigatória em toda escrita.
- Relatórios de desperdício, recomendações e propostas de nós (somente leitura): definir com o que já existe quem pode ver. Proponho Admin e Developer; Guest apenas o overview atual. Confirme antes de implementar.
- **SSO:** hoje é Azure AD. Adicionar **OIDC genérico** (issuer, client id/secret, claims de e-mail configuráveis) para clientes EKS sem Azure AD. Não quebrar o fluxo atual.

## 11. API (proposta; alinhar ao estilo do backend atual)

- `GET /api/rightsizing/workloads` — lista com request vs uso, desperdício, confiança.
- `GET /api/rightsizing/workloads/{ns}/{kind}/{name}` — detalhe por container (séries, percentis, recomendação e motivo).
- `POST /api/ingest/rollups` — usado pelos agentes (autenticado, não exposto ao usuário).
- `GET /api/hpa/{ns}/{name}` — HPA atual, status, sugestão.
- `POST /api/hpa/preview` — dry-run server-side, retorna YAML e diff. **Admin**.
- `POST /api/hpa/apply` — aplica. **Admin**, com verificação de que o estado do cluster ainda bate com o preview.
- `POST /api/hpa/{ns}/{name}/undo` — **Admin**.
- `GET /api/audit?...` — consulta à auditoria (definir acesso; sugestão: Admin).
- `GET /api/nodes/pools` — node pools/groups, tipo, custo, ocupação.
- `GET /api/nodes/proposal` — proposta por pool (cenários A/B/C, bloqueadores, premissas).
- *(4b, não implementar agora)* `POST /api/nodes/apply/preview`, `POST /api/nodes/apply`, `POST /api/nodes/abort` — **Admin**.

## 12. Fases de entrega

**Fase 1 — Coleta e relatório (somente leitura).**
Agente, central, rollups no tmjLite, histograma, tela de relatório request vs uso, desperdício em recursos (e em $ quando houver preço).
*Aceite:* em um cluster de teste, dados de 24 h aparecem por workload/container; percentis conferem com uma medição independente dentro do erro documentado; reinício de container não corrompe CPU; agente resiste a central indisponível.

**Fase 2 — Recomendações.**
Regras da seção 7, confiança, explicação, adaptadores de preço Azure e AWS.
*Aceite:* recomendação nunca reduz após OOMKill; cold start mostra confiança baixa; sem preço disponível o relatório mostra só recursos.

**Fase 3 — HPA Manager.**
Seção 8, RBAC condicional, values do Helm, auditoria, desfazer, OIDC genérico.
*Aceite:* Developer/Guest recebem 403 nos endpoints de escrita (teste automatizado); com `hpaManager.enabled=false` nenhuma Role de escrita existe no cluster; diff mostra exatamente o que muda; HPA de terceiros não é sobrescrito sem confirmação; desfazer restaura o estado anterior.

**Fase 4a — Proposta de nós (somente leitura).**
Seção 8b.1: snapshots, simulação de empacotamento, cenários A/B/C, bloqueadores, diagnóstico do autoscaler.
*Aceite:* nenhuma escrita nem permissão nova; em cluster de teste a simulação "sem mudanças" não propõe economia quando o resultado ≥ nós atuais; toda restrição não modelada aparece como workload fixo com motivo; sem preço, a proposta mostra só contagem de nós; a proposta nunca viola as restrições modeladas (teste de propriedade).

**Fase 4b — Aplicação em nós (opt-in; só com pedido explícito).**
Seção 8b.2, incluindo a decisão sobre influenciar o autoscaler vs. drenar direto.
*Aceite:* desligada por padrão sem credenciais criadas; `node-writer` em Deployment separado com identidade própria e escopo por pool; preview + dry-run; limite por execução; abortar/reverter; auditoria completa.

**Depois (não implementar agora):** automação de requests, KEDA, exportar YAML/PR.

## 13. Testes

- Unitários: parser cAdvisor, cálculo de taxa de CPU com reset de contador, fusão de histogramas e erro dos percentis, regras de recomendação, geração do HPA.
- Autorização: matriz perfil × endpoint (Admin/Developer/Guest), incluindo tentativa de forjar perfil por parâmetro.
- Integração: cluster local (kind) para o fluxo completo; validação manual em **um AKS e um EKS**.
- Chart Helm: `helm template` com `hpaManager.enabled` e `nodeOptimizer.apply.enabled` true/false e conferência das Roles/identidades geradas.
- Simulador de nós: fixtures com PDB, anti-afinidade, taints, PVC zonal e topologySpread; teste de propriedade (a proposta nunca viola restrições modeladas); comparação com o comportamento real do scheduler em cluster local (kind).

## 14. Pontos em aberto / riscos

- Permissões do kubelet e certificado em AKS/EKS **[VERIFICAR]**.
- Escrita concorrente no tmjLite **[VERIFICAR]**.
- Formatos e limites das APIs de preço **[VERIFICAR]**.
- Fargate / virtual nodes: modo degradado.
- Um ServiceAccount único (MVP) amplia o impacto se o pod for comprometido; mitigação atual: flag desligada por padrão, Role por namespace, auditoria. Evolução planejada: componente `writer` em Deployment separado, chamado só após a checagem de Admin.
- Reduzir requests sem consolidação de nós não reduz custo: comunicar isso claramente ao usuário.
- A simulação de nós é aproximada: restrições não modeladas viram workloads fixos, e a economia é sempre apresentada como estimativa com premissas.
- Concorrentes e autoscalers (Karpenter, Cluster Autoscaler, NAP) já consolidam; o valor da 4a é explicar por que não consolida e estimar o ganho, não substituí-los.
- Fase 4b exige credencial de nuvem, o que hoje o produto evita de propósito: por isso é opt-in, separada e em componente próprio.
