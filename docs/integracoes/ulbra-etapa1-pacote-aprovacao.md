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

## 4. Orçamento: consumo estimado x limite controlado

Teto medido: **500 chamadas/dia por pessoa** (`meu_acesso`, 07/11/2026). Tratado
como teto único, sem assumir orçamento separado entre OAuth e backend.

**Limite CONTROLADO pelo código (garantido):**
- cada chamada passa pelo portão `Orcamento` antes de sair;
- o saldo do dia da sincronização nunca passa de **440** (`500 - 60` de reserva
  para as fichas dos operadores);
- dentro de um ciclo, paginação e leitura de detalhe param quando o saldo acaba,
  e o ciclo sai `INCOMPLETO` sem fingir página vazia;
- `MAX_PAGINAS = 3` (páginas com coleta por ciclo) e `HARD_LEITURAS = 12`
  (leituras totais por ciclo, incluindo as que só pulam).

**Consumo ESTIMADO (previsão, não garantia):**

Conta por janela, com `DETALHE_POR_CICLO = 1` (uma leitura de detalhe por ciclo)
e margem de 15% sobre o tráfego da sincronização:

| Item | 12 horas (72 ciclos) | 24 horas (144 ciclos) |
| --- | --- | --- |
| `listar_conversas` (1 página em regime) | 72 | 144 |
| `listar_atendimentos` (a cada 30 min) | 24 | 48 |
| `ler_conversa` (fila de detalhes, K=1) | 72 | 144 |
| base | 168 | 336 |
| margem de falha e repetição (15%) | 26 | 51 |
| fichas dos operadores (reserva) | 30 | 60 |
| **total previsto** | **224** | **447** |
| teto controlado (sync) | — | 440 |
| envios de mensagem | 0 | 0 |

Leitura: K=1 cabe nas duas janelas. K=2 **não** cabe: 12h daria ~300 (acima de
250, metade do teto) e 24h daria ~552 (acima de 440, o teto controlado corta
antes do fim do dia). Os testes em `fila.test.ts` provam essas contas.

**Não medido, e que muda o número:**
- backlog (ciclos com teto de páginas atingido) gasta mais leituras. Essas
  leituras ENTRAM no limite controlado; o efeito é atraso, não estouro;
- retentativas de detalhe: entram na margem de 15%. Em falha persistente, cada
  conversa tenta até 5 vezes antes de desistir;
- frequência de 10 min é **nominal**: pode subir por falha da API ou limite.

## 4a. Fila de detalhes: convergência e perda

Conversa entra na fila quando muda na janela e a última mensagem não é do
cliente. Sai quando lida ou desistida. Ordem: mais antiga primeiro. Uma linha
por conversa (sem duplicar).

**Condição de convergência, demonstrada em `fila.test.ts`:** a fila esvazia
enquanto a chegada média por ciclo for **≤ K**. Com chegada 2 e K=1 a fila cresce
sem limite (teste documenta esse lado). Logo, **K=1 só converge se a chegada
média for de até 1 conversa a cada 10 minutos**. Esse número não foi medido em
produção. Por isso a aprovação inclui: observar `ulbra_sync_estado.detalhe_fila_tamanho`
nas primeiras 24 horas. Se a fila crescer sem parar, a decisão é aumentar K
(custo) ou aceitar a perda registrada.

**Perda declarada, não silenciosa:**
- conversa que falha 5 vezes é desistida e contada em `detalhes_desistidos`;
- `ler_conversa` mostra só as últimas 20 mensagens: resposta do cliente mais
  antiga que isso, com 20 mensagens do operador depois, não aparece.

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

---

## 12. Revisão desta rodada (08/11/2026): o que mudou e o que ficou provado

### 12.1 Chegada vs capacidade: quando a fila converge

Modelo: backlog inicial **B** conversas; chegada média **λ** por ciclo; capacidade
**K** leituras por ciclo. Cada conversa precisa de **P** páginas de
`ler_conversa` (capacidade efetiva **K/P** conversas por ciclo).

| Condição | Comportamento | Prova (`fila.test.ts`, `fila2.test.ts`) |
| --- | --- | --- |
| λ < K/P | backlog esvazia em ≈ B / (K/P − λ) ciclos | λ=0,5, K=1, B=20: esvazia entre os ciclos 38 e 44 |
| λ = K/P | backlog **não** diminui; fica em B | λ=1, K=1, B=20: fica em 20 |
| λ > K/P | cresce a cada ciclo | λ=2, K=1: 40 após 40 ciclos |

Atraso esperado para o item na posição **p** da fila: ≈ p·P/K ciclos (× 10 min).

**Consequência:** "chegada igual à capacidade" **não** elimina o backlog, e
a configuração só serve com folga (λ·P < K). A medição de λ em produção é a
condição de aceite, não uma suposição.

### 12.2 Conta por consumidor, 12 horas (72 ciclos)

Fórmula, uma linha por consumidor:

    total_12h(K) = (L + A + K·72) + ceil(0,15 · (L + A + K·72)) + F

| Consumidor | Chamadas | Natureza |
| --- | --- | --- |
| L `listar_conversas` (1 página por ciclo em regime) | 72 | estimativa de regime |
| A `listar_atendimentos` (a cada 3º ciclo) | 24 | estimativa |
| K·72 `ler_conversa` (fila de detalhes, K leituras por ciclo) | 72 (K=1) | limite de código: K por ciclo |
| margem de falha e retentativa | 15% sobre a base | estimativa |
| F reserva das fichas dos operadores | 30 | **não é consumo da sincronização** |
| envios de mensagem | 0 | esta etapa não envia |

- **K=1: 168 + 26 + 30 = 224.** Cabe na convenção de 250.
- **K=2: 240 + 36 + 30 = 306.** Não cabe na convenção de 250.

A convenção de 250 é **metade do teto diário**, usada só para dividir a janela.
**Não é limite da API.** O limite garantido é o diário, abaixo.

### 12.3 Alcance do teto: o que ele controla e o que não controla

**O teto de 440 por dia controla somente a sincronização.** Ele não impede:
- as chamadas das **fichas** dos operadores (reservadas 60 por dia, sem garantia);
- os **envios** (zero nesta etapa, mas a função não os impede se existirem);
- o **OAuth** de gestão, que usa a mesma conta de pessoa do limite de 500/dia.

Se o consumo de fora passar de 60, o limite da pessoa pode estourar **antes** de
a sincronização chegar a 440. A sincronização não tem como saber disso sem o
saldo real da API.

**Saldo real da API: não medido.** A função lê `x-ratelimit-remaining`,
`ratelimit-remaining` ou `x-ratelimit-remaining-day` nos cabeçalhos da resposta
e aplica o menor valor. Se nenhum vier, o controle fica só local, e isso é o
estado atual. **Antes de publicar, medir a resposta real da Mensageria** e
confirmar se algum cabeçalho desses existe. Sem isso, a garantia é local.

### 12.4 Esgotada não é descartada: pendência preservada e alerta

Após 5 falhas, a conversa **sai da fila ativa e vira pendência** em
`ulbra_detalhe_pendencias`, com data e motivo. Ela não some.

- `ulbra_sync_estado.detalhes_pendencias_abertas` conta as abertas;
- `ulbra_sync_estado.alerta_gestao` traz o texto do alerta, visível à gestão;
- `ulbra_detalhe_reabrir(conversa)` devolve a conversa à fila com tentativas
  zeradas. **Só a gestão** executa; a pendência continua registrada, com quem
  reabriu e quando.

### 12.5 Detalhe paginado: recupera resposta anterior à última mensagem

`ler_conversa` devolve **20 mensagens por página**, da mais recente para a mais
antiga. Uma página **não basta**: se não há mensagem do cliente nela e há mais
antigas, a função continua com `antesDe` e guarda o ponto de retomada na fila
(`antes_de`). Só conclui quando:

- há mensagem do cliente, e a data é o máximo daquela página (a primeira página
  com cliente tem a mais recente dele); **ou**
- não há mais mensagens: não existe resposta a provar, e isso é registrado como nulo.

Prova: histórico de 60 mensagens, cliente só na 3ª página. A 1ª página **não**
conclui; a retomada com `antesDe` encontra a resposta em 2 chamadas
(`fila2.test.ts`, "retomando com antesDe").

**Limite:** o alcance é o que `ler_conversa` devolve. Histórico com mais de 60
mensagens de operador depois da última do cliente exige mais páginas, e cada
página é uma chamada do orçamento.

### 12.6 Registro: #859

A PR **#859 foi fechada como substituída pela #861, sem merge**, por decisão da
Amanda. A branch `claude/relaxed-satoshi-e50fb7` e os commits permanecem no
remoto, em `b8f666d8`, como referência documental. Não reaberta. Cinco arquivos
existem só nela e não na #861 (`ulbraRespostas.js` e o teste dele,
`ulbraRespostasFonte.js`, e a migration `ulbra_mensagens_e_leitura` com rollback).
Reaproveitar SQL de lá exige renumerar: `20261108120000` está aposentada.

### 12.7 Recomendação para a janela de 12 horas

Configuração recomendada, **para aprovação, não aplicada**:

- ciclo de **10 minutos** (72 por janela de 12 horas);
- **K = 1** leitura de detalhe por ciclo, com `antesDe` para paginação;
- teto diário de sincronização **440** (controle local por chamada) + saldo da API quando existir;
- reserva de **60** por dia para fichas, **sem** garantia de cumprimento;
- consumo previsto: **224** por 12 horas (estimativa); faixa de 224 a 300 se o backlog for frequente.

**Condições antes de publicar:**
1. medir λ·P em 24 horas com K=1 (condição de convergência, 12.1);
2. medir os cabeçalhos de saldo da Mensageria (12.3);
3. confirmar com a TI da ULBRA se a credencial é de serviço ou de pessoa.

**Limitações que permanecem:** a perda de respostas além de 60 mensagens de
operador; o alcance do teto (12.3); as pendências dependem da gestão reabri-las.

---

## 13. Correção desta rodada (08/11/2026): substitui 12.3, 12.7 e as contas anteriores

### 13.1 Saldo real: contrato medido de `meu_acesso`

Chamada de leitura, medida nesta sessão (`chamada 6af0623f9ab1d6401cdac914`),
conexão OAuth de gestão:

    "limites": {
      "conexaoPorMinuto": {"limite": 15, "restam": 13},
      "pessoaPorMinuto":  {"limite": 30, "restam": 28},
      "pessoaPorDia":     {"limite": 500, "restam": 443},
      "rascunhosPorHora": {"limite": 20, "restam": 20}
    }

- **O saldo diário é `limites.pessoaPorDia.restam`.** O campo estava no fixture
  de teste do diagnóstico (`diagnostico.test.ts`), e a leitura real confirmou.
- **Não há cabeçalho de saldo.** A leitura de cabeçalhos que eu tinha proposto
  foi removida: não foi medida e não existe no contrato.
- `restam` é de **uma pessoa**: a da conexão que faz a chamada. A sincronização
  consulta o saldo com o **token de backend**, então o número que ela lê é o da
  pessoa desse token. Se for a mesma pessoa da gestão, OAuth e fichas aparecem
  nele; se não for, não aparecem. **Pendência:** confirmar com a TI da ULBRA.
- **Custo:** `meu_acesso` é uma chamada. A sincronização a faz **uma vez por hora**
  (24 por dia), dentro do orçamento.
- O controle local usa **o menor entre o saldo local e `restam`**. A reserva de 60
  para fichas é política, **não garantia**: o saldo real pode cair abaixo dela
  por consumo que a sincronização não vê.

### 13.2 Conta por consumidor (sem teto artificial de 250)

Configuração comparada: ciclo de 10 min; atendimentos a cada 30 min; `meu_acesso`
a cada 60 min; K leituras de detalhe por ciclo. Margem de 15% sobre a base.
Reserva das fichas à parte (**não** é consumo da sincronização).

| Janela | Consumidor | K=1 | K=2 |
| --- | --- | --- | --- |
| 12 h (72 ciclos) | listar_conversas | 72 | 72 |
| | listar_atendimentos | 24 | 24 |
| | ler_conversa (detalhe) | 72 | 144 |
| | meu_acesso | 12 | 12 |
| | margem 15% | 27 | 38 |
| | **sincronização** | **207** | **290** |
| 24 h (144 ciclos) | listar_conversas | 144 | 144 |
| | listar_atendimentos | 48 | 48 |
| | ler_conversa (detalhe) | 144 | 288 |
| | meu_acesso | 24 | 24 |
| | margem 15% | 54 | 76 |
| | **sincronização** | **414** | **580** |
| 24 h | + reserva de fichas | 60 | 60 |
| 24 h | **total previsto** | **474** | **640** |
| 24 h | cabe em 500? | **sim (26 de folga)** | **não** |

**Leitura da tabela:**
- **K=2 não cabe em 24 horas** com cadência de 10 min, mesmo sem nenhuma outra
  chamada: só a sincronização já passa de 500 (580).
- **K=1 cabe**, com 26 de folga. A folga é pequena: se o consumo de fora
  (OAuth, fichas, envios) for maior que 26 por dia, o limite da pessoa estoura.
  Por isso o controle depende de `restam` real (13.1).
- Antes desta correção, a conta de K=1 **não** incluía `meu_acesso` e somava 336
  por dia na base. Com `meu_acesso` a cada hora, a base sobe para 360.

### 13.3 Recomendação para a janela de 12 horas

**Recomendo K=1**, com:
- ciclo de 10 min, atendimentos a cada 30 min, `meu_acesso` a cada 60 min;
- controle por chamada: menor entre o saldo local (teto 440) e `restam` lido;
- consumo previsto de **207 na sincronização** em 12 horas (**474 em 24 horas**, com fichas);
- limitação: K=1 só converge se a chegada média multiplicada por P (páginas por
  conversa) for menor que 1 por ciclo. **Esse número ainda não foi medido** (13.5).

**K=2 não recomendo.** Não cabe em 24 horas nesta cadência. Se a chegada medida
exigir mais capacidade, a alternativa é aumentar o intervalo do ciclo de detalhe
(menos ciclos, mesmo K), e não K.

### 13.4 Alcance de 60 mensagens: nunca "sem resposta" por truncamento

- Até **3 páginas** (60 mensagens) por tentativa de detalhe.
- Se a resposta do cliente aparece dentro desse alcance, é encontrada (teste
  "resposta na 3ª página").
- Se o histórico acaba sem cliente, **conclui sem resposta**, porque o histórico
  foi lido por inteiro (teste "histórico que acaba sem cliente").
- Se o alcance acaba e ainda há histórico, **gera pendência `ALCANCE_ESGOTADO`
  visível**, com o ponto de retomada (`antesDe`) guardado. Não conclui nada.
  Reabrir pela gestão devolve a conversa à fila **nesse ponto**, não do zero
  (prova SQL em `07_reabrir_pendencia.sql`).

### 13.5 Medição de chegada em 24 horas: protocolo e custo para aprovação

**Objetivo:** medir λ, o número de conversas por ciclo cuja última mensagem não
é do cliente, e o tamanho da lista de detalhe necessária. Isso fecha a condição
de convergência (12.1) com dado, não com suposição.

**Como é lido, sem nenhuma ação sobre a operação:**
- só ferramentas de leitura: `listar_conversas` (canal `whatsapp`, situação
  `active`, limite 50, página 1) e `meu_acesso`;
- **nenhum** `ler_conversa`, nenhum envio, nenhum `assumir`, nenhuma transferência
  e nenhuma notificação;
- λ sai da própria listagem: conversas com `ultimaMensagemEm` dentro de cada
  janela de 10 min e `ultimaMensagem.quem` diferente de `cliente`.

**Custo:** 144 chamadas de `listar_conversas` (1 por 10 min, 24 horas) + 2 de
`meu_acesso` (início e fim) = **146 chamadas**, cerca de **29% do limite diário**.
Essas chamadas saem do mesmo saldo da operação enquanto durarem, por isso a
coleta precisa de aprovação e roda com a conexão de gestão, fora da sincronização.

**Limitação da medição:** a listagem só mostra a última mensagem. Uma resposta
do cliente seguida de operador **não** aparece em λ. Então λ é o número de
conversas que **precisariam** de detalhe, e não o número de respostas perdidas.
Isso é o que a fila dimensiona.

**Validação não depende de publicar:** a coleta roda com a conexão já autorizada,
antes de qualquer publicação. Não exige migration, função nem cron.

### 13.6 Pendências concretas

1. **Aprovar a coleta de 24 h** (13.5, 146 chamadas). Sem ela, λ segue desconhecido.
2. **Confirmar com a TI da ULBRA** se o token de backend é da mesma pessoa da
   gestão (muda o significado de `restam`, 13.1) e se o limite é compartilhado.
3. **Medir o consumo de fora da sincronização** (fichas, envios, OAuth) nas
   mesmas 24 h, para fechar a folga de 26 (13.2).
4. Rotação de `ULBRA_MCP_TOKEN`: segue com a TI.
5. Eventos ou webhooks da plataforma: não verificado.
6. Aplicar, publicar e agendar: **nenhum** passo foi executado. Cada um depende da
   aprovação do pacote.

