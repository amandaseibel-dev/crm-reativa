# ULBRA — Etapa 1 do recebimento: pacote de aprovação única

**Estado: NADA aplicado, NADA publicado.** Este documento reúne tudo que a
implantação exige, para uma aprovação só. Cada item abaixo diz o que é, o que
prova e o que NÃO prova.

PR de rascunho: #861 (branch `feat/ulbra-etapa1-recebimento`).

## 1. O que muda, em uma frase

Respostas de aluno e novos atendimentos da equipe Reativa aparecem no sino do
ReATIVA. Quem fala com a Mensageria é uma função só, por cron. A tela lê o
espelho no banco e não consome orçamento da Mensageria por operador aberto.

## 2. Ordem de implantação (cada passo só depois do anterior)

1. **Aplicar a migration** `supabase/aguardando_aprovacao/20261108140000_ulbra_recebimento_e_fila.sql.pendente`.
   Cria 4 tabelas (`ulbra_conversas`, `ulbra_atendimentos`, `ulbra_sync_estado`,
   `ulbra_leitura_usuario`) e 5 funções. Não altera objeto existente.
2. **Publicar a função `ulbra-sincronizar`** com `verify_jwt = false`
   (`supabase/config.toml` já traz a entrada). O portão dela é o cabeçalho
   `x-sync-chave`; sem ele responde 403 e não toca na Mensageria.
3. **Gravar o segredo** `ULBRA_SYNC_CHAVE` no ambiente da função, com o mesmo
   valor de um segredo no Vault com nome `ulbra_sync_chave`.
4. **Disparar um ciclo à mão**, conferir o resultado com alguém olhando.
5. **Agendar o cron**, só depois do passo 4:
   ```sql
   select cron.schedule('ulbra_sincronizar', '*/10 * * * *',
                        'select public.ulbra_sincronizar_disparar();');
   ```

## 3. Por que um segredo novo (`ULBRA_SYNC_CHAVE`)

O cron chama a função sem sessão de usuário. A função precisa de um portão
próprio. Não reutilizo `ULBRA_MCP_TOKEN`: é a credencial da ULBRA. Usá-la como
portão daria a quem conhecesse a chave de sincronização um caminho para a
Mensageria. O valor nunca aparece em código, log ou documento.

## 4. Orçamento: composição

Teto medido: **500 chamadas/dia por pessoa** (`meu_acesso`, 07/11/2026). Tratado
como teto único, sem assumir orçamento separado entre OAuth e backend.

| Item | Cadência | Chamadas/dia | Natureza |
| --- | --- | --- | --- |
| `listar_conversas` (1 página em regime) | 10 min | 144 | **estimativa** de regime |
| `listar_atendimentos` (fila de espera) | 30 min | 48 | **estimativa** |
| `ler_conversa` nas fichas | sob demanda | 60 | **estimativa** |
| margem de falha e repetição | 15% | 38 | **estimativa** |
| **total em regime** | | **290** | |

**Limite imposto pelo código, não estimativa:**
- `MAX_PAGINAS = 3`: páginas COM coleta por ciclo;
- `HARD_LEITURAS = 12`: leituras totais por ciclo, incluindo páginas só puladas;
- `DETALHE_POR_CICLO = 0`: leitura de detalhe **desligada** (ver seção 6);
- freio diário: o ciclo não roda com 488 chamadas gastas no dia.

**Não medido, e que pode mudar o número:**
- ciclos em backlog gastam até 12 leituras; com backlog frequente, o consumo
  sobe. O freio diário protege o limite, mas NÃO divide o orçamento com as
  fichas de forma justa: as fichas podem perder chamadas em dia de backlog;
- frequência de 10 min é **nominal**: pode subir por falha da API ou por limite.

## 5. Cron e atraso

- Frequência nominal: 10 minutos. Atraso médio até o sino: ~5 min; máximo ~10 min.
- Pode aumentar por falha, por limite de chamadas ou por backlog acima do
  teto. Quando isso acontece, o ciclo sai `INCOMPLETO` e a gestão vê em
  `ulbra_sync_estado`.

## 6. Limite de comportamento: resposta do cliente seguida de operador

Medido em 08/11/2026: `listar_conversas` mostra **só a última mensagem** da
conversa. Se o cliente responde às 05:00 e o operador responde às 05:05, a
lista mostra o operador, e a resposta do cliente não aparece.

- Com `DETALHE_POR_CICLO = 0` (padrão), essa resposta **não é avisada**. É a
  perda conhecida desta etapa.
- Para fechar a perda, `ler_conversa` precisa ser chamado para essas conversas.
  Custo: até `DETALHE_POR_CICLO` chamadas por ciclo. Com K=1 são +144/dia.
  **Decisão de aprovação:** ou o orçamento sobe para caber o detalhe, ou a
  perda fica aceita e registrada, ou a Mensageria passa a oferecer eventos.

A prova automatizada disso está em `sincronizar.test.ts` (grupo "resposta do
cliente seguida de operador") e em `05_resposta_seguida_de_operador.sql`.

## 7. Migration: o que cada função faz

- `ulbra_sync_gravar(jsonb)` — porta de escrita do espelho. Só `service_role`.
  Não move a janela quando o ciclo falha.
- `ulbra_atendimento_assumir(text)` — posse por `UPDATE` condicional. Dois
  operadores não assumem o mesmo; o segundo recebe `JA_ASSUMIDO` com o nome de
  quem chegou primeiro.
- `ulbra_atendimento_dispensar(text, text)` — devolve o caso à fila, com motivo.
- `ulbra_conversa_marcar_lida(text)` — marca leitura **por usuário**, na própria
  linha. Não zera o aviso de ninguém mais.
- `ulbra_sincronizar_disparar()` — chama a função de sincronização com o
  segredo do Vault. Sem grant para `anon`/`authenticated`.

## 8. Leitura por usuário: o que está provado

- Cada pessoa vê e escreve só a própria linha em `ulbra_leitura_usuario` (RLS).
- A gestão NÃO lê o marcador de terceiros.
- Marcar como lida pelo operador A não zera a conversa para o responsável B.
- Operador vê só conversa de aluno caso dele, e atendimento sugerido a ele.
- Conferência e SEM_OPERADOR ficam só com a gestão.

**Contrato de autenticação usado pelos stubs (medido em produção, 08/11/2026):**
`app_email()`, `app_usuario_ativo()`, `eh_painel()` e `usuario_e_gestao()`
foram comparadas com `pg_get_functiondef`. A gestão real é uma **lista fixa**
de três e-mails (`amanda.seibel`, `cobranca04`, `cobranca07`), não uma coluna
de perfil. Os testes usam cópias dessas definições, não stubs livres.

## 9. Provas executadas

| Prova | Onde roda | Resultado |
| --- | --- | --- |
| Módulo de sincronização (paginação, backlog, interrupção, mensagem no meio, empate) | `vitest`, local e CI | 34/34 |
| Tela e regras de leitura por usuário | `vitest`, local e CI | 33/33 |
| SQL: grants, leitura por usuário, assumir, carteira, resposta seguida de operador, rollback | PGlite (Postgres WASM), local e suíte | passa |
| Mesmo SQL num Postgres 16 real | job `ulbra-recebimento-sql` no CI | **aguardando CI** |
| Sensibilidade: política global de leitura | mutação na migration | falha (confirmado) |
| Sensibilidade: sobrescrever data do cliente | mutação na migration | falha (confirmado) |

**Não provado:** que a função roda contra a Mensageria real com a credencial de
backend. A primeira leitura controlada deve validar a forma da resposta e falhar
fechado se divergir.

## 10. Rollback

Arquivo: `supabase/aguardando_aprovacao/20261108140000_ulbra_recebimento_e_fila.rollback.sql`.

Ordem, se for preciso desfazer:
1. `select cron.unschedule('ulbra_sincronizar');` — se o passo 5 já tiver rodado;
2. desligar a função `ulbra-sincronizar` (remover o deploy);
3. rodar o `.rollback.sql`.

O rollback remove só o que a etapa criou. Se houver linha com responsável ou
dispensa, copiar antes (o próprio arquivo traz o comando de backup).

## 11. Pendências fora deste pacote

- Confirmar com a TI da ULBRA: a natureza da credencial (serviço ou pessoa) e se
  o limite de 500/dia é compartilhado entre OAuth e backend.
- Rotação de `ULBRA_MCP_TOKEN`: pendente com a TI da ULBRA (ver histórico em
  `mensageria-ulbra.md`). Não há valor de credencial neste documento.
- Eventos ou webhooks da plataforma: **não verificado**. As páginas públicas não
  documentam nada, e `/api/docs` exige autenticação.
