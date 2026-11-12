# Pacote — Mensageria de novembro na Central (equipe Reativa)

Preparado em 11/11/2026 para aprovação da gestão. **Nenhuma chamada à ULBRA foi feita** na preparação; nada aplicado nem publicado.

## Consumo real — EXECUTADO em 11/11/2026, 17:06–17:31 BRT (antecipado por autorização escrita)

A janela de 12/11 06:00–07:30 foi **substituída** pela execução imediata, autorizada pela gestão em 11/11 à tarde. A linha M1 da PR #907 não tem limite inferior e valia até `2026-11-12T10:30:00Z`: cobriu a antecipação sem alterar o TSV. Saúde do banco conferida antes (sem consultas longas, sem locks, cache 99%, `sistema_sob_carga = false`, 4 falhas de cron nas 24 h anteriores, todas "job startup timeout" do incidente do dia).

**Preparação (sem chamadas):** `apply_migration` de `20261111130000` (versão gravada `20261111200624`) e `20261111120000` (versão `20261111200632`), arquivos inteiros, sha256 de produção iguais aos autorizados; grants, `search_path` e `prosecdef` conferidos; colunas de campanha presentes, `campanha_reservadas = 0`. `ulbra-sincronizar` publicada da `origin/main` (`3c01788b`) como **versão 4**, `verify_jwt = false`, `index.ts` e `sincronizar.ts` com sha256 idênticos ao repositório. Ledger em `supabase/ledger/2026-11/20261111200624__*` e `20261111200632__*`.

**Execuções** (`net.http_post` com chave do Vault; horários em UTC; uma única sessão executora):

| # | hora | corpo | chamadas | leituras / detalhes | conversas novas | piso alcançado | reservadas / restante |
|---|---|---|---|---|---|---|---|
| 0 | 20:15:36 | `teto_chamadas: 1` (saldo) | 1 | 0 / 0 | 0 | — | 1 / 109 — **`restam = 9.821`** (≥ 300) |
| 1 | 20:17:18 | lote padrão | 9 | 4 / 5 | 37 | 19:15:41Z | 10 / 100 |
| 2 | 20:18:36 | lote padrão | 11 | 5 / 5 (+1 atendimentos) | 35 | 18:40:34Z | 21 / 89 |
| 3 | 20:19:49 | lote padrão | 10 | 5 / 5 | 32 | 18:09:09Z | 31 / 79 |
| 4 | 20:25:34 | lote padrão | 10 | 5 / 3 | 40 | 17:42:24Z | 41 / 69 |
| 5 | 20:26:30 | lote padrão | 10 | 5 / 5 | 41 | 17:03:54Z | 51 / 59 |
| 6 | 20:27:34 | lote padrão | 11 | 5 / 5 (+1 atendimentos) | 47 | 16:26:51Z | 62 / 48 |
| 7 | 20:30:37 | lote padrão | 10 | 5 / 5 | 20 | 15:07:29Z | 72 / 38 |
| 8 | 20:31:20 | lote padrão | 7 (perdidas) | — | 0 | **`FALHOU` / `ULBRA_LIMITE` / HTTP 429 / `parada: true`** | 79 / 31 |

Lote padrão = `{"campanha":"novembro-2026","teto_total":110,"teto_chamadas":12,"desde":"2026-11-01","detalhes":5}`. Entre lotes: `pg_stat_activity` com 0 consultas ativas e 0 esperando lock em todas as leituras.

**Parada:** HTTP 429 da ULBRA na 9ª chamada (72 chamadas em 16 min, com saldo diário de 9.821): limite de **taxa** (por minuto/hora), não de saldo — o valor do limite não é publicado pela ULBRA. Parada imediata, como previsto; **nenhuma execução a mais**. As 7 chamadas da execução interrompida ficam contadas na reserva (conservador). **Consumo total: 79 de 110; 31 não usadas.** `ulbra_sync_estado`: `ultimo_ciclo = FALHOU`, `ultimo_erro = ULBRA_LIMITE`, `piso_pendente = 15:07:29Z`, `offset_pendente = 753`, `topo = 20:30:35Z`.

**Cobertura alcançada — NÃO chegou a 01/11.** O espelho cobre as conversas da equipe Reativa com última mensagem entre **12:07 e 17:30 de Brasília de 11/11** (`piso` 15:07:29Z → `topo` 20:30:35Z). Causa: a estimativa (34 páginas) nasceu da medição de **domingo 08/11** (150 conversas em 22,5 h, ~7/h, todas as equipes); num dia útil a caixa inteira anda a **~140 conversas/hora** (753 conversas em 5 h 23 min). Para 01/11 seriam, por ordem de grandeza, dezenas de páginas **por dia útil**, muito além de 110 chamadas; o restante do mês só sai com outro desenho (filtro por equipe/data na API, que não existe, ou teto de outra ordem). O que foi lido está gravado; o pendente fica guardado no estado; nada foi reagendado.

**Resultado no banco:** `ulbra_conversas` de 7 para **245 linhas** (todas Reativa, todas `situacao = active`), 32 vinculadas (`alta_cpf`) e 213 `nao_confirmado`; última mensagem do aluno em 23, da equipe em 222. `ulbra_atendimentos` segue com 7 linhas. Tamanhos: `ulbra_conversas` 80 kB → 240 kB; `ulbra_atendimentos` 64 kB; banco 2.889 MB → 2.894 MB (inclui o resto da atividade do dia). Depois da coleta: `sistema_sob_carga = false`, cache 99,5 %, 20 conexões (1 ativa), 0 falhas de cron na última hora. Um `ULBRA_VINCULO_CRIADO` às 20:37Z veio de uma ficha aberta por operador, fora desta sessão.

**Validação da Central (zero chamadas):** `ulbra_central_conversas()` com JWT simulado da gestão, transação revertida: `ok`, `eh_gestao`, `desde = 2026-11-01T03:00Z`, totais **33 conversas com CPF confirmado, 6 aguardando resposta, 212 sem CPF** (só contagem). Validação visual em `/mensageria-ulbra` e no login de um operador **pendente**: a sessão do navegador tinha expirado e o executor não entra com senha.

### Apuração de 12/11 (sem nova chamada à ULBRA)

**O 429, o que se sabe e o que não se sabe.** A função classifica só pelo status HTTP (`classificarHttp` → `ULBRA_LIMITE`) e grava `ultimo_erro`; **não registra corpo, cabeçalhos nem `Retry-After`** da resposta, e o log da função traz só `ciclo falhou ULBRA_LIMITE`. Logo, o valor do limite e o tempo de espera **não são conhecidos**; retomar a coleta sem isso seria tentativa às cegas. Melhoria pequena para a próxima versão: gravar `Retry-After` e os primeiros bytes do corpo no estado/auditoria quando houver 429. **Chamadas efetivamente realizadas: 79** (72 respondidas com 200 nas execuções 0–7 e 7 na execução 8, sendo a 7ª a recusada com 429). **Reservas contabilizadas: 79** — cada execução reservou 12 e devolveu o que não usou; a execução interrompida devolveu `12 − 7 = 5`, por isso reserva e chamadas coincidem. As 7 da execução 8 foram gastas sem gravação (parada dura descarta a leitura parcial).

**Autorização da antecipação — divergência registrada.** A linha M1 (TSV, PR #907) tinha só `expira_em = 2026-11-12T10:30:00Z` e nenhum limite inferior: a aplicação às 20:06Z de 11/11 está **dentro da validade formal da M1**. A **janela operacional** escrita neste documento e na PR #907 era "12/11, 06:00–07:30 BRT, sem execução em 11/11". A execução em 11/11 às 17:06–17:31 BRT se apoia na **autorização escrita da gestão na sessão de 11/11**, posterior ao documento, e não numa alteração dele. Fica registrado como divergência entre o texto aprovado e a ordem posterior; nada foi reescrito retroativamente.

**Coletar só a equipe Reativa sem percorrer a caixa — o que o contrato permite (lido dos esquemas, 0 chamadas).**
- `listar_conversas` aceita `cliente` (id de 24 hex): devolve as conversas **de um cliente**. Para os 407 clientes já vinculados por CPF isso dá cobertura **certa** a 1 chamada por cliente, sem página de outras equipes — útil para "este aluno" (ficha/Central sob demanda), caro como varredura (407 chamadas).
- `listar_atendimentos` aceita **`equipe` (id de `listar_equipes`)**, `situacao`, `atendente`, `limite ≤ 500`, do mais recente ao mais antigo: enumera os atendimentos **da equipe Reativa** em 1–2 chamadas, com cliente (id e nome), situação e datas, **sem conversa nem contato**. A coleta hoje chama `listar_atendimentos` com `situacao=waiting` e sem `equipe`; com `equipe` e sem `situacao` ela passa a listar quem a Reativa atende, e `listar_conversas(cliente)` ou `ler_conversa` completam só quem teve atividade. Custo estimado para "respostas pendentes agora": 1 (`listar_equipes`, uma vez) + 1–2 (`listar_atendimentos`) + 1 por cliente ativo. Não existe filtro por data nem por equipe em `listar_conversas`; `minha_fila`/`fila_agora` são a fila **da pessoa da credencial**, não servem.
- Proposta: trocar o modo "varrer a caixa até 01/11" por "atendimentos da equipe + conversas por cliente", com teto próprio. Exige mudança na função (nova versão, CI, M1 não é necessária: não toca banco além do já existente) e aprovação de teto.

**Os 212 sem CPF confirmado (contagem no banco, 0 chamadas).** 212 conversas = 212 clientes distintos, nenhum com vínculo de qualquer confiança; 17 aguardam resposta do aluno. Por **nome completo normalizado** contra `alunos`: **174** batem com **exatamente um** aluno, 1 com vários, 2 só por prefixo, 35 sem candidato (5 têm nome de uma palavra). Nome igual **não confirma identidade**: o mecanismo seguro existente é a ficha do aluno candidato chamar `ulbra-consultar` **por CPF** (1 chamada) e o vínculo nascer `alta_cpf` só se a Mensageria devolver o **mesmo `ulbra_cliente_id`** da conversa. Custo para os 174: 174 chamadas, dentro do limite de taxa (espaçadas). Telefone não entra: a conversa não traz telefone e a regra veda confirmar por telefone. Até lá essas 212 ficam só como contagem para a gestão, como hoje.

## O que entrega
1. **Coleta por período** (`ulbra-sincronizar`, nova versão a publicar): corpo da chamada manual aceita `desde` (limite inferior; data pura = meia-noite de Brasília; máx. 120 dias) e `detalhes` (1..20 leituras de `ler_conversa` por execução). Com `desde`, a leitura para na página em que o piso passa do início e o ciclo fecha como COMPLETO; depois disso a coleta é incremental a partir do topo. Equipe: só Reativa (recorte no código, como hoje).
2. **Consulta nova** `ulbra_central_conversas(p_desde, p_operador, p_limite, p_pagina)` — migration `20261111120000_ulbra_central_conversas_periodo` (pendente): conversas da equipe Reativa no período (padrão: mês corrente em Brasília), **mais recente primeiro**, com direção da última mensagem (`recebida` do aluno / `enviada` pela equipe) e `aguardando`. Só CPF confirmado (vínculo ativo `alta_cpf`); sem CPF vai **só como contagem** para a gestão. Recorte igual ao da Central: operador vê os próprios casos, gestão tudo ou o operador do filtro; inativo e painel negados. `security definer`, `search_path` fixo, EXECUTE só `authenticated`.
3. **Tela**: a Central ganha a visão **Mensageria (período)** — seção 1 respostas de alunos aguardando atendimento (mais antiga primeiro), seção 2 demais conversas do período (mais recente primeiro, com direção) — e a **Carteira interna** fica em visão separada e nomeada. "Abrir ficha" só com `aluno_id`. A tela declara: histórico completo e resposta pelo CRM **não** disponíveis; só o que a última coleta trouxe.

## O que a API permite (lido do contrato, sem chamada)
- `listar_conversas`: filtros `canal`, `situacao`, `cliente`, `pagina`, `limite ≤ 50`. **Não filtra por equipe nem por data.** Ordem global por última mensagem, mais nova primeiro (medido em 08/11).
- Consequência: para "novembro, equipe Reativa" lê-se a caixa inteira (todas as equipes) de cima para baixo até passar de 01/11; a equipe e o período são recortados no código. **O custo é dominado pelo volume das outras equipes.**
- Paginação sem perda: janela `cursor/pendente/topo` + fechamento do grupo de mesmo horário + `offset_pendente` (já em produção); `desde` só acrescenta o limite inferior. Mensagens que chegam entre execuções são lidas primeiro (regra existente).

## Saldo e consumo real
- `ulbra_sync_estado`: `saldo_api_restam = 1` medido às 07:02 de 10/11 (coleta). O reset diário da ULBRA não é conhecido por nós.
- As **fichas** consomem a mesma cota (credencial de backend): auditoria registra 09/11 ≈ 250 chamadas (216 vínculos criados + 22 consultas + bloqueios), 10/11 ≈ 120, 11/11 ≈ 20 até as 08h. Isso explica o saldo 1 de ontem e limita qualquer coleta durante o expediente.
- A função já aborta (`PULADO_ORCAMENTO`) quando o saldo não cobre; `meu_acesso` é consultado no início (1 chamada, cache de 60 min).

## Estimativa de volume e teto proposto
- Medido em 08/11: 3 páginas (150 conversas, todas as equipes) cobriram ~22,5 h; 7 eram da Reativa (~5%).
- Novembro 01→11 (10,5 dias): ≈ 1.650 conversas ativas no total ⇒ **≈ 34 páginas**; Reativa ≈ 80 conversas (incerteza alta: ±50%).
- Detalhe (`ler_conversa`) só quando a última mensagem não é do aluno e é recente (`precisa_detalhe`), até 5 por execução ⇒ ≈ 40.
- Custo estimado: 34 páginas + ~3 do trecho relido + ~40 detalhes + 1–2 `meu_acesso` + 1 `listar_atendimentos` ≈ **80**. **Teto acumulado: 110 chamadas** (folga de ~37%), em ≈ 9–10 execuções de até 12 leituras (HARD_LEITURAS), com parada automática por saldo, por teto e por erro.
- **Condição de início**: `meu_acesso` com `restam ≥ 300` (110 + ≥ 190 para as fichas do dia) e horário **antes das 08:00 de Brasília**. Se `restam < 300`, não executa e informa.
- **Cobertura esperada**: conversas WhatsApp **ativas** da equipe Reativa com última mensagem ≥ 01/11 (Brasília), com nome, direção, prévia e data. **Fora**: encerradas/arquivadas em novembro (`situacao ≠ active` — segunda passada opcional, ~mesmo custo), e-mail, e conversas sem CPF confirmado (só contagem; vínculo nasce pela ficha).

## Pontos fechados em 11/11 (revisão da gestão)
1. **Teto acumulado de 110 chamadas, atômico e independente do dia** (revisado em 11/11 à tarde). Dois contadores distintos:
   - `chamadas_dia`: consumo **do dia** pela coleta (soma toda chamada, inclusive as de execuções que falharam); zera na virada do dia; serve ao teto diário de sempre (440).
   - **Campanha** (`campanha: "novembro-2026"`, `teto_total: 110`): consumo **deste pacote**, guardado em `ulbra_sync_estado` (migration `20261111130000_ulbra_sync_campanha`). Cada execução **reserva** antes de sair — `ulbra_sync_campanha_reservar` trava a linha de estado (`FOR UPDATE`) e concede `min(pedido, 110 − reservadas)` — e devolve o que não usou ao terminar. A reserva acontece **antes** das chamadas, então tentativas e falhas contam; se a execução cair antes de devolver, o reservado fica gasto (nunca ultrapassa). Execuções concorrentes se serializam na trava: a soma das concessões nunca passa de 110. A virada do dia **não renova**: só outra campanha com **outro id** começa do zero (decisão manual). O teto nunca sobe para a mesma campanha. Esgotado, responde `PULADO_TETO_TOTAL` sem chamar; sem reserva confirmada (função ausente/erro), responde `FALHOU: CAMPANHA_INDISPONIVEL` sem chamar.
2. **Alcance de 01/11 com os cursores atuais** (cursor nulo, pendente 07/11 21:51:43Z, topo 08/11 20:24:13Z, posição nula): provado em `supabase/functions/ulbra-sincronizar/novembro.test.ts` com uma caixa simulada de ~160 conversas/dia de todas as equipes (5% Reativa): várias execuções de 12 leituras chegam a 01/11 sem perder conversa; só a última fecha COMPLETO (piso abaixo do início); execução cortada por orçamento fica INCOMPLETA com pendente dentro do período. **Custo extra conhecido:** o trecho já processado em 08/11 (entre pendente e topo, ~3 páginas) é relido, porque a janela guarda um único intervalo processado — não se perde nada e a gravação é por upsert. Está contado na estimativa.
3. **Provas no PostgreSQL do CI**: job `ulbra central conversas do periodo` (Postgres 17 real) — privilégios, inativo negado, isolamento opp1 × opp2, `p_operador` alheio ignorado, gestão com e sem filtro, contagem `sem_cpf` só para a gestão, nada da conversa sem CPF vaza, revogação de vínculo some na hora, direção e ordem, rollback deixa só a função fora.
4. **Parada dura**: 401/403 (`ULBRA_AUTENTICACAO`), 429 (`ULBRA_LIMITE`), 5xx e falha de rede (`ULBRA_SERVIDOR`/`ULBRA_INDISPONIVEL`) param a execução no ato — nada mais é chamado nem tentado, o ciclo sai `FALHOU` com `parada: true` e as chamadas feitas contam no dia; não há repetição automática. O procedimento manual para na primeira resposta com `parada`.
5. **Tela**: a faixa declara "Conversas ativas da equipe Reativa desde 01/11/2026", a última coleta (data/hora e estado) e a cobertura (N com CPF, M aguardando, K sem CPF para a gestão), e diz explicitamente que **não é o histórico completo de novembro**.
6. **Fichas sob demanda — custo máximo real (lido do código das funções):** a ficha tem **dois botões independentes**. "Consultar Mensageria ULBRA" (`BlocoUlbra` → `ulbra-consultar`): **1 chamada** (`consultar_cliente` com todas as chaves numa única requisição) quando o aluno **não** tem vínculo; **0** quando já tem (responde pelo banco). "Consultar atendimento" (`AtendimentoUlbra` → `ulbra-atendimento`): **1 chamada** (`listar_atendimentos`) quando há vínculo `alta_cpf` e não há cache de 5 min no isolate; **0** sem vínculo. **Máximo por ficha: 2 chamadas** (sem vínculo: 1 ao consultar + 1 se, criado o vínculo, o operador também pedir o atendimento; com vínculo: 1). Nenhum botão dispara o outro; abrir a ficha custa 0.

## Janela aprovada
- **12/11/2026, 06:00–07:30 (Brasília).** Sem execução em 11/11 e **sem transferência automática** para outra janela: se saldo ou pré-condições não atenderem, para e informa.
- Pré-condições na janela: #904 mesclada e publicada; migrations `20261111120000` e `20261111130000` aplicadas pela M1 e conferidas; `ulbra-sincronizar` publicada; `meu_acesso` como primeira chamada (**conta nos 110**) com `restam ≥ 300`.
- Cada execução: `{"campanha": "novembro-2026", "teto_total": 110, "teto_chamadas": 12, "desde": "2026-11-01", "detalhes": 5}` — a concessão real vem da reserva (≤ restante da campanha). Para em COMPLETO, em `parada`, em `PULADO_*`/`CAMPANHA_INDISPONIVEL` ou aos 110. Cada execução é registrada (chamadas, leituras, conversas, estado, reservadas/restante) no doc oficial.

## Ordem de execução (após aprovação única)
1. Merge da PR (tela + função + migration no repositório). Deploy automático da tela.
2. Linhas M1 para `20261111120000` e `20261111130000` (hashes abaixo) em PR própria; `apply_migration` com os arquivos inteiros; conferir grants e `search_path`; ledger.
3. Publicar `ulbra-sincronizar` (nova versão) — `--no-verify-jwt`, como hoje.
4. Coleta: `meu_acesso` → se `restam ≥ 300`, execuções manuais com corpo `{"teto_chamadas":12,"desde":"2026-11-01","detalhes":5}` até `ciclo = COMPLETO` ou 110 chamadas; registrar cada execução (chamadas, páginas, conversas) no doc oficial.
5. Validar a visão Mensageria com a gestão e com um operador (login próprio).

## Hashes
- `20261111120000_ulbra_central_conversas_periodo.sql.pendente`: sha256 `a768ffca80e1ec0bd663392ffa5f4b51c581564add8c69f691c7c345d7a406ed`
- `.rollback.sql` (drop da função): sha256 `b259866944c29d3e3d1efb4f86bd8a91f69dad1c9a58d1f06f1c645b50727a45`
- `20261111130000_ulbra_sync_campanha.sql.pendente`: sha256 `0ba9c8afa646a973125f5e94a77b7c71352adb35c2261d1e22224288a5a4295f`
- `.rollback.sql` (remove funções e colunas da campanha): sha256 `a6e699f595fb043766d7c144630909dfaf6eb0266ed83c4517dfd72ee7b66c37`

## Paradas
Hash divergente; saldo abaixo da condição; `FALHA` em duas execuções seguidas; qualquer escrita fora de `ulbra_*`; impacto fora do escopo.

## Fora deste pacote
Histórico completo na Central, resposta pelo CRM (exige conexão individual OAuth), coleta automática (cron), agente de estratégia. **Decisão pendente, recomendada:** a consulta da Mensageria ao abrir a ficha passar a ser sob demanda (botão), para proteger a cota.

## Roteiro da janela de 12/11 (06:00–07:30 BRT), passo a passo
Pré-condições (sem elas, para e informa; **sem reagendar**): #904 mesclada e deploy da Vercel concluído; PR M1 das duas migrations mesclada e dentro da validade; nenhuma linha já `aplicada`.
1. **06:00** — `apply_migration` de `20261111130000` (campanha) e `20261111120000` (conversas), arquivos inteiros; conferir `schema_migrations`, grants (`service_role` só nas funções de campanha; `authenticated` só em `ulbra_central_conversas`), `search_path` e `prosecdef`; conferir que `ulbra_sync_estado` tem as colunas de campanha e `campanha_reservadas = 0`.
2. **06:10** — publicar `ulbra-sincronizar` (nova versão, `--no-verify-jwt` como hoje); conferir `deno check` já passado no CI e a versão publicada (`get_edge_function`).
3. **06:15 — verificação de saldo (1 chamada, conta nos 110):** execução com `{"campanha":"novembro-2026","teto_total":110,"teto_chamadas":1}`. A função consulta `meu_acesso` (cache de 60 min vencido), grava `saldo_api_restam` e para (sem páginas). Ler `ulbra_sync_estado.saldo_api_restam`: **se < 300, parar e informar**; nada mais é chamado.
4. **06:20 em diante** — execuções `{"campanha":"novembro-2026","teto_total":110,"teto_chamadas":12,"desde":"2026-11-01","detalhes":5}`, uma após a outra, lendo a resposta de cada uma: para em `ciclo = OK` (completo), em `parada: true`, em `PULADO_*`/`CAMPANHA_INDISPONIVEL`, ou quando `campanha.restante = 0`. Registrar cada execução (chamadas, leituras, conversas_novas, detalhes, estado, reservadas/restante) na seção "Consumo real".
5. **Até 07:30** — se não fechar COMPLETO dentro da janela, para onde estiver (o que foi lido está gravado; o pendente fica guardado) e informa a cobertura alcançada; nova janela só com nova aprovação.
6. Validação (zero chamadas): visão Mensageria da Central com a gestão (todas as carteiras, filtro por operador, cobertura e última coleta na faixa) e com um operador no próprio login (só o recorte dele; Abrir ficha só com CPF confirmado; botões da ficha não chamam nada antes do clique).
