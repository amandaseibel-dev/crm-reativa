# Mensageria ULBRA — o que é armazenado, tamanho medido e proposta de retenção

Medição em produção (`ahattpqrjmhkzsmnbdzs`), 11/11/2026, somente leitura, **antes do primeiro lote de novembro**. Zero chamadas à ULBRA.

## 1. Exatamente o que é gravado (por tabela)

| Tabela | O que guarda (texto incluído) | O que NÃO guarda |
| --- | --- | --- |
| `ulbra_conversas` | id da conversa e do cliente na Mensageria, **nome do cliente como a Mensageria informa**, canal, situação, equipe (só `Reativa`), nome do atendente da Mensageria, data da última mensagem, **quem** mandou (cliente/operador/bot/sistema), **trecho da última mensagem** (`ultima_mensagem_previa`, medido: média 82, máx. 99 caracteres), data da última mensagem do cliente, `aluno_id` e `aluno_status` (identidade só por vínculo `alta_cpf`), `criado_em`/`atualizado_em` | telefone, e-mail, CPF, o histórico de mensagens (só o trecho da última), anexos |
| `ulbra_atendimentos` | id do atendimento e do cliente, nome do cliente, equipe, situação, coluna do kanban, data de entrada, identidade (`aluno_id`/`aluno_status`), destino sugerido e motivo, responsável/assumido/dispensado (e-mails internos), datas | contatos, mensagens |
| `ulbra_detalhe_fila` | ids de conversa/cliente a reler, tentativas, ponto de retomada — transitório (sai ao concluir) | — |
| `ulbra_detalhe_pendencias` | ids, motivo da pendência, datas, quem recuperou | — |
| `ulbra_leitura_usuario` | e-mail interno do usuário, id da conversa, "lido até" | — |
| `ulbra_sync_estado` | 1 linha: cursores, contadores do dia, saldo da API, campanha (após 20261111130000) | — |
| `ulbra_vinculos` | aluno ↔ cliente da Mensageria, confiança (`alta_cpf`/`alta`/`reconfirmar`), origem, quem vinculou, datas; **`telefone_e164` preenchido em 346 de 357 linhas** (gravado pela `ulbra-consultar` na criação do vínculo) | CPF |
| `auditoria` (ações `ULBRA_*`) | usuário, ação, `aluno_id`, e em `detalhes`: **quais chaves** casaram (`chaves`), resultado, confiança, origem, `ulbra_cliente_id`, flags (`telefone_concordou`, `telefone_fora_do_escopo`, `em_atendimento`), HTTP | o valor do telefone ou do CPF (a função grava só *qual* chave casou) |

Nada de conteúdo de conversa é copiado em massa: a coleta grava o trecho que `listar_conversas` devolve; `ler_conversa` (detalhe) só serve para achar a data da última mensagem do cliente e **não grava o texto** das mensagens.

**Ponto de atenção (dado pessoal):** o único telefone armazenado na integração está em `ulbra_vinculos.telefone_e164`. Não é gravado pela coleta; vem da consulta pela ficha. A proposta de retenção abaixo trata dele.

## 2. Tamanho medido antes do primeiro lote (11/11/2026)

| Tabela | linhas | tamanho total (índices incl.) | heap | média por linha |
| --- | ---: | ---: | ---: | ---: |
| `ulbra_conversas` | 7 | 80 KB | 8 KB | 289 B |
| `ulbra_atendimentos` | 7 | 64 KB | 8 KB | 171 B |
| `ulbra_detalhe_fila` | 4 | 48 KB | 8 KB | — |
| `ulbra_detalhe_pendencias` | 0 | 16 KB | 0 | — |
| `ulbra_leitura_usuario` | 3 | 32 KB | 8 KB | 95 B |
| `ulbra_sync_estado` | 1 | 32 KB | 8 KB | — |
| `ulbra_vinculos` | 357 | 344 KB | 152 KB | 153 B |
| `auditoria` (toda) / só `ULBRA_*` | 10.265 / 418 | 8,3 MB / ~150 KB | — | 366 B (ULBRA) |

Os tamanhos "totais" de tabelas pequenas são dominados por páginas fixas de índice (8 KB cada): o número útil para projeção é a média por linha.

### Como medir depois do primeiro lote (entra no roteiro da janela de 12/11)
Anotar `T0` = instante da primeira execução. Depois do lote:
```sql
-- novos x atualizados pela coleta (a coleta NÃO cria vínculos nem auditoria)
select 'conversas' t, count(*) filter (where criado_em >= :T0) novos, count(*) filter (where criado_em < :T0 and atualizado_em >= :T0) atualizados from public.ulbra_conversas
union all
select 'atendimentos', count(*) filter (where criado_em >= :T0), count(*) filter (where criado_em < :T0 and atualizado_em >= :T0) from public.ulbra_atendimentos;
-- tamanhos (mesma consulta da medição "antes")
select table_name, pg_total_relation_size('public.'||table_name) bytes_total, pg_relation_size('public.'||table_name) bytes_heap
  from information_schema.tables where table_schema='public' and table_name like 'ulbra%' order by 1;
```
Esperado para o lote de novembro (equipe Reativa, ativas, 01→12/11): **≈ 80 conversas novas (±50%)**, poucas atualizadas (as 7 já espelhadas), atendimentos em espera da Reativa (dezenas), **0 vínculos novos**, **0 auditoria** pela coleta. Em bytes: ≈ 80 × ~600 B (linha + índices) ≈ **50 KB**.

## 3. Estimativa de crescimento mensal

Premissas: ~160 conversas ativas/dia na caixa (todas as equipes, medido em 08/11), ~5% da Reativa; a coleta grava **uma linha por conversa** e a atualiza no lugar (upsert) — o tamanho cresce por conversa distinta, não por mensagem.

| Origem | por mês | tamanho |
| --- | ---: | ---: |
| `ulbra_conversas` (Reativa, com coleta regular) | 150–300 conversas | 0,1–0,2 MB |
| `ulbra_atendimentos` | dezenas | < 0,05 MB |
| `ulbra_leitura_usuario` (usuários × conversas lidas) | até ~1.000 | ~0,1 MB |
| `ulbra_vinculos` (criados pela ficha: 216 em 09/11, 104 em 10/11) | 2.000–4.000 | 0,5–1,0 MB (índices incl.) |
| `auditoria` `ULBRA_*` (consultas e vínculos pela ficha) | 2.000–5.000 | 0,8–1,8 MB |
| **Total** | | **≈ 2–3 MB/mês** |

Conclusão: o volume é pequeno; a retenção é questão de **minimização de dado pessoal e de clareza operacional**, não de espaço. Com as fichas sob demanda (#904) o crescimento de vínculos/auditoria tende a cair.

## 4. Proposta de retenção (para decisão; nada aplicado)

| Dado | Retenção proposta | Por quê |
| --- | --- | --- |
| `ulbra_conversas` com CPF confirmado | **12 meses** após `ultima_mensagem_em`; depois apagar | espelho operacional, re-coletável; 12 meses cobre o ciclo de cobrança do ano letivo |
| `ulbra_conversas` **sem CPF confirmado** (`nao_confirmado`) | **90 dias** após `ultima_mensagem_em` | nome e trecho de pessoa que pode não ser aluno: minimização (LGPD) |
| `ulbra_atendimentos` | **12 meses** após `atualizado_em` (encerrados); abertos permanecem | mesmo critério |
| `ulbra_leitura_usuario` | junto com a conversa | não faz sentido sem ela |
| `ulbra_detalhe_fila` | transitório (já sai ao concluir) | — |
| `ulbra_detalhe_pendencias` | **90 dias** após `recuperada_em`; abertas permanecem | registro operacional de pendência |
| `ulbra_vinculos` | **permanente** (histórico de identidade, imutável por gatilho; nunca apagar); **`telefone_e164` → anonimizar (nulo) 12 meses após `desvinculado_em`** e, para vínculos ativos, avaliar não guardá-lo — a identidade é o `ulbra_cliente_id`, não o telefone | auditoria de quem foi vinculado a quem; o telefone é o único dado pessoal de contato da integração |
| `auditoria` `ULBRA_*` | **5 anos** (alinhado ao prazo prescricional cível), como o restante da `auditoria`; sem valores de contato | prova de quem consultou/vinculou o quê |
| `ulbra_vinculos_backup_20261104` (0 linhas) e `ulbra_vinculos_estrutura_backup_20261104` (15 linhas) | apagar após **90 dias** da migration (a partir de 04/02/2027), com registro no ledger | backups de migração já conferida |

**Como aplicar (próxima etapa, migration própria):** função `ulbra_retencao_aplicar()` (security definer, só `service_role`/gestão) que apaga/anonimiza pelos prazos acima e grava uma linha de auditoria com as contagens; execução **manual mensal pela gestão** (cron continua 0). Antes de apagar conversas, conferir que nenhuma pendência aberta aponta para elas.

Fora do escopo: dados do WhatsApp próprio do ReATIVA e tabelas financeiras (retenção própria).
