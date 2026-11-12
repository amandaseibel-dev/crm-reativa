# Aba Jurídico — seleção, bloqueio e encaminhamento (12/11/2026)

Migration `20261112180000_juridico_encaminhamento.sql` — **não aplicada**. Aplicar exige
autorização específica (RUNBOOK-MIGRATIONS).

## Fluxo

| Etapa | RPC | Efeito |
|---|---|---|
| Ver candidatos | `juridico_candidatos` | leitura; nada gravado |
| Gerar lista preliminar | `juridico_lote_gerar` | cria lote com protocolo `JUR-AAAAMMDD-NNNN` e casos `EM_ANALISE` |
| Substituir / remover | `juridico_caso_substituir`, `juridico_caso_remover` | caso vira `REMOVIDO` (fica no histórico); substituir traz o próximo do mesmo critério |
| Documento | `juridico_caso_documento_vincular`, `juridico_caso_autorizar_documento` | registra link/localização do termo ou a autorização do jurídico |
| Acordo ativo | `juridico_caso_aprovar_acordo_ativo` | aprovação específica, com motivo |
| Aprovar | `juridico_caso_aprovar` | fotografa os títulos e **bloqueia a cobrança** |
| Excel + envio | `juridico_lote_enviar_financeiro`, `juridico_lote_exportar` | `APROVADO → ENVIADO_FINANCEIRO`; Excel só com aprovados |
| Confirmar | `juridico_casos_confirmar_juridico` | `ENVIADO_FINANCEIRO → CONFIRMADO_JURIDICO` (encaminhado; **não** é ajuizamento) |

Toda RPC confere `usuario_e_gestao()`. As quatro tabelas `juridico_*` têm RLS ligada, sem
policy e sem grant: só se lê e escreve pelas RPCs.

## Regras medidas, não presumidas

- **Carteira**: mensalidade `ABERTO`, vencida, com vencimento a partir de 01/01/2025, mais
  parcelas vivas de acordo `ATIVO` com parcela vencida ("quebrado").
- **Sem duplicar**: mensalidade `NEGOCIADO` ou vinculada a acordo não cancelado
  (`acordo_titulo_vinculo`) aparece na conferência e **não soma** — soma a parcela.
- **Grupos** (por `alunos.situacao_academica`): Formado/Concluído → `FORMADO`;
  Trancado/Trancamento Institucional → `TRANCADO`; Cancelado/Desvinculado/Cancelamento
  Institucional → `EVADIDO`. "Término do Contrato" (3.915 alunos) **não** foi classificado
  como evadido — decisão da gestão.
- **Período do formado**: a base não guarda data de conclusão (`alunos.semestre` é nulo nos
  formados; `prime_academico_vinculo` só tem `graduated`). O filtro de ano/semestre usa
  `alunos.semestre_divida`.
- **Fora da seleção**: aluno já em lote vivo, com bloqueio administrativo, com título
  `EM_CONFIRMACAO` ou solicitação de confirmação de pagamento pendente.

## Bloqueio — por que não há mecanismo novo

A aprovação grava `JURIDICO` em `alunos.status_atual`, `status_jornada` e
`status_acionamento`, como a tabulação JURIDICO (só-gestão) já faz: 65 dos 69 alunos em
jurídico em produção em 12/11/2026 têm o código nas três colunas. Quem já lê esse estado:

| Caminho de cobrança | Onde é barrado |
|---|---|
| Massivas e elegibilidade | `aluno_bloqueio_administrativo` → `aluno_elegibilidade_cobranca` |
| Fila, giro, nivelamento, redistribuição | `alunos_propaga_encerramento_para_caso` → `casos.encerrado_operacional` |
| Alertas automáticos D-2 | `aluno_bloqueado_para_d2` |
| Acionamento manual na ficha | `STATUS_BLOQUEADOS_ACIONAMENTO` (lê `status_jornada`) + gatilho `_encerramento_so_gestao` |

O bloqueio é **por aluno**: todos os títulos dele saem da cobrança, não só os aprovados.
Nenhuma linha de `acordos_titulos`, `parcelas` ou `acordos` é escrita. O estado anterior
fica em `juridico_casos.bloqueio_anterior` e é restaurado por `juridico_caso_remover`
enquanto o caso está `APROVADO`. Depois do envio ao financeiro a aba não desfaz.

Fail-closed: se a tabulação JURIDICO ganhar `efeito_desfecho` ou `redireciona_para_email`,
a aprovação recusa (os gatilhos de `status_jornada` passariam a ter efeito financeiro).

## O que não está nesta entrega

- Busca automática do termo cobre os anexos do CRM (`termos_acordo`, `casos.termo_url`).
  Drive e outros repositórios entram por vínculo manual (link/localização); não há upload
  de arquivo pela aba.
- Registro de ajuizamento efetivo e retorno do jurídico.
- Os painéis de estoque de carteira continuam somando a dívida do aluno em jurídico, como
  já fazem hoje com os 69 existentes.

## Rollback

`supabase/rollbacks/20261112180000_juridico_encaminhamento.rollback.sql` — recusa rodar
enquanto houver caso com cobrança bloqueada pela aba; guarda cópia das quatro tabelas.
