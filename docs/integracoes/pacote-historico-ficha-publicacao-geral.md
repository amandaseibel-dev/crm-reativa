# Histórico da Mensageria na ficha do aluno: publicação geral (para aprovação)

**Status:** preparado. Nada foi publicado, mesclado nem chamado na ULBRA. Não há piloto restrito a um operador: a liberação é para todos os operadores ativos, com o servidor decidindo o acesso.

## O que muda
- **Acesso:** qualquer operador com sessão vê o botão na ficha. Sem lista nominal.
- **Quem lê:** só o dono da carteira, o responsável comprovado pelo atendimento, ou gestão. CPF confirmado é obrigatório. Sem permissão, nega antes de qualquer chamada.
- **Consulta:** só no clique. Abrir a ficha não chama a Mensageria.
- **Exibição:** data e hora da consulta, data de cada mensagem, saldo da cota e quando foi medido. Não se apresenta espelho como informação atual.
- **Busca de usuário:** por e-mail exato (`eq`). A versão publicada hoje ainda usa `ilike`, que trata `_` e `%` como curingas.
- **OAuth e envio:** desligados. Nada deste pacote envia mensagem.

## Orçamento: valores propostos (NÃO aplicados em produção)
| item | valor proposto | origem |
|---|---|---|
| limite por operador por dia | **20 leituras** | `LIMITE_OPERADOR_DIA` |
| reserva do saldo que o histórico nunca gasta | **100** | `RESERVA_GLOBAL` |
| orçamento compartilhado do dia | saldo medido menos a reserva | cálculo no servidor |
| validade da medida de saldo | **15 minutos** | `SALDO_VALIDADE_MS` |
| **teto diário total do histórico (todos os operadores)** | **150 leituras** | `TETO_HISTORICO_DIA` (novo: teto fixo, independe do saldo) |

Saldo medido em **11/11/2026** (valor de referência, defasado). O teto de saldo usa a fotografia guardada pela coleta; a primeira renovação depois da publicação atualiza o saldo com uma chamada `meu_acesso`, dentro da reserva do próprio clique.

**Dimensionamento (14/11/2026, leitura de produção, somente leitura):**
- 7 operadores (perfil `operador`): até 20 chamadas por usuário/dia cada; pior caso 140.
- 2 de leitura global (amanda.seibel e cobranca04; lista própria da #948, não é por perfil): acesso amplo; até 20 chamadas cada; cobranca07 (ADM) só lê a própria carteira. Pior caso de cota: 60 chamadas.
- 4 de outros perfis (`carteira`, `diretoria`, `juridico`, `painel`): leem só quando são dono da carteira ou responsáveis pelo atendimento; até 20 cada; pior caso 80.
- Pior caso por usuário: 280 chamadas/dia. O teto compartilhado de 150/dia limita o total real.

**O que conta no orçamento compartilhado:** toda chamada que consome cota da ULBRA: leitura de histórico, renovação de saldo (`meu_acesso`) e tentativa, inclusive a que falha depois da reserva. Nenhuma delas é contada como 'leitura' à parte.

**Compatibilidade com coleta e demais funções:** não comprovada. A reserva de 100 não garante capacidade para a coleta: o saldo é uma foto do dia e a coleta consome do mesmo saldo. Antes da publicação, o consumo real da coleta precisa ser lido e comparado com o saldo medido.

**Ponto em aberto que muda o número:** a ULBRA mediu 500 chamadas/dia por pessoa na conexão OAuth do piloto, e não confirmou se o limite vale também para a credencial de backend (que é o que o histórico usa). Se valer, o orçamento compartilhado precisa caber nesse teto junto com a coleta. O teto de 150 é uma proposta: não há prova de que ele caiba no cenário de 500/dia por pessoa, porque isso depende de a ULBRA confirmar o limite. A confirmação é uma chamada de `meu_acesso` com a credencial de backend (1 chamada, sob orçamento aprovado).

**Saldo medido:** 9.821 em 11/11/2026, defasado. É usado no teto de saldo (fotografia guardada pela coleta); a primeira consulta depois da publicação renova o saldo.

**Pergunta para aprovação:** confirmar, alterar ou recusar os quatro valores (operador/dia 20, reserva 100, validade 15 min, teto diário 150) e autorizar a chamada única de `meu_acesso` para confirmar o limite da credencial de backend. Até a aprovação, a publicação usa os valores acima exatamente como estão no código.

## Proteções
- **Concorrência:** o orçamento é reservado no banco, por dia, com trava. Teste em PostgreSQL 17 com contador inicial conhecido: 12 cliques simultâneos de 2 unidades com teto 20 → 10 permitidos; 200 tentativas de 20 operadores com teto global 150 → 150 permitidas (dia vazio) e 128 com 22 de partida (dia parcialmente consumido), sempre igual ao contador final menos o inicial.
- **429:** parada imediata. A função não repete. A resposta informa `ULBRA_LIMITE`.
- **Falha após a reserva:** conta como chamada e não é repetida automaticamente.

## Isolamento entre operadores (testado no handler real, sem rede)
- dono da carteira lê; outro operador é negado sem chamada;
- dois donos na carteira: negado para ambos (identidade ambígua);
- responsável comprovado pelo atendimento lê;
- sem CPF confirmado, ninguém lê, nem a gestão;
- gestão lê aluno de qualquer carteira;
- usuário inativo é negado;
- duplicidade ativa do e-mail é negada.

## Testes e CI
- Servidor: 61 testes passam no diretório da função (Vitest 2.1.9, na raiz com link de dependências no CI).
- Front: 175 arquivos e 2538 testes passam; lint sem erros nos arquivos alterados.
- Postgres isolado com reservas simultâneas: job `ulbra-historico-teto-postgres`.
- `deno check` da função: job `ulbra-historico-deno-check`.

## Hashes dos arquivos que a publicação envia
| arquivo | sha256 |
|---|---|
| `supabase/functions/ulbra-historico/index.ts` | `7476300f3dbbf10685519363728a0027ab9a0224d7be270ca806c1ad48c0fe81` |
| `supabase/functions/ulbra-historico/historico.ts` | `1355a8b08446cfe56874f44d4c766b24706acb78806aadd88255cd7706d1b93c` |
| `supabase/functions/ulbra-historico/leitura.ts` (diferente da v1 só por comentário; v1 = 20cc12d3…) | `2bb97fa41b8d606c2b545e689c60238f984e622083d638cd48a90049a8e0067b` |

## Publicação (sequência ÚNICA, cada passo com autorização)
Esta é a única sequência válida. Não há outra no pacote.
1. Pré-condição: rotação do `ULBRA_MCP_TOKEN` concluída pela TI, com revogação do token antigo registrada.
2. Pré-condição: diagnóstico único de `/ulbra-diagnostico` executado por Amanda após a rotação; registrar só limites, saldo, escopos e data.
3. Aprovação final dos quatro valores de orçamento e desta versão do pacote.
4. **Teste em staging antes de produção (pré-condição NÃO COMPROVADA até o ref ser informado):** o ref do projeto de staging não está identificado no repositório, e o checkout está ligado à produção. Antes deste passo, informar o ref de staging, confirmá-lo por `ambiente.sh`, aplicar a migration nele pelo caminho do ledger e rodar um teste PostgREST que leia o formato de claim desse projeto (o `postgrest_guarda.cjs` atual gera segredo próprio e não prova o claim do projeto). Só avança se passar.
5. **Aplicar em produção pelo caminho do ledger**, não por `psql`: `apply_migration` com o arquivo; depois registrar o SQL aplicado em `supabase/ledger/2026-11/<version>__<nome>.sql` e uma linha em `supabase/ledger/2026-11/INDICE.tsv` (version, nome, arquivo, md5 e bytes conforme `supabase/ledger/LEIA-ME.md`); conferir `schema_migrations`. Sha256 do arquivo: 1e4bb622… Rollback pronto antes.
6. Mesclar a #948 (clique humano).
7. Publicar `ulbra-historico` com `supabase functions deploy ulbra-historico --project-ref ahattpqrjmhkzsmnbdzs`, **sem** `--no-verify-jwt`. Conferir `verify_jwt = true` e os três hashes de publicação.
8. Conferir sem chamar a ULBRA: sem token dá 401; aluno sem CPF confirmado dá 403.
9. Validação com operadores e gestão na tela logada.

**Ponto não comprovado:** se o limite de 500/dia por pessoa vale para a credencial de backend. O probe de `meu_acesso` (uma chamada, sob autorização sua) responde isso; não foi executado.

## Reversão
- Função: versão 1 em `docs/integracoes/rollback-ulbra-historico-v1/` (`SHA256SUMS`). Redeploy sem `--no-verify-jwt`.
- Tela: a porta deixa de exibir o botão com uma linha de código.
- Banco: nada é apagado. A tabela de uso continua; a versão 1 ignora o orçamento.

## O que não está feito
- Nenhum limite de produção foi alterado.
- A validação visual na tela logada depende de sessão de operador, que não tenho aqui.

## Versão final para aprovação (15/11/2026)

**Ligação na tela:** a aba "💬 Conversa ULBRA" fica em `src/pages/Aluno.jsx`, a ficha que os operadores usam. A tela recebe `key` por aluno, então o estado não passa de um aluno para outro. Nada é consultado ao abrir a ficha; a consulta é só no clique. Build de produção: passa. Testes da tela: 7/7.

**Banco instalado (verificado por ledger):** `20261112111006__20261110100000_ulbra_historico_orcamento.sql` já aplicada. Tabela `ulbra_historico_uso` e função `ulbra_historico_reservar`, com grant só para `service_role`. Nada é reaplicado aqui.

**Migration pendente (pré-requisito da publicação):** `supabase/aguardando_aprovacao/20261115120000_ulbra_historico_bloqueio_e_guarda_reserva.sql.pendente`, com rollback. Ela (a) adiciona em `ulbra_sync_estado` as colunas de bloqueio após 429 (`historico_bloqueado_ate`, `historico_bloqueado_sem_prazo`); (b) põe uma guarda dentro da função de reserva, que só aceita o papel de serviço no JWT. Grants recriados, sem ampliação. Testada em Postgres descartável (5/5): colunas, recusa sem o papel, reserva com o papel, `authenticated`/`anon` sem EXECUTE, rollback.

**Orçamento antes de qualquer chamada externa:** saldo vencido reserva 2 unidades (renovação + leitura) antes da primeira chamada. Com saldo válido, reserva 1. Tentativa que falha depois da reserva conta. Teto por usuário 20/dia; teto compartilhado 150/dia (mínimo com reserva de 100).

**429 e bloqueio compartilhado:** 429 para na hora, sem repetição. Se a ULBRA informa `Retry-After` em segundos, o bloqueio dura esse prazo. Sem `Retry-After`, o bloqueio não tem prazo inventado: fica ativo até a gestão limpar `historico_bloqueado_sem_prazo`. Enquanto vigora, nenhum clique chama a ULBRA nem reserva orçamento.

**Dia do orçamento:** calendário de São Paulo (`diaDoOrcamento`), testado na virada 02:59:59Z → 14 e 03:00:00Z → 15.

**Testes do servidor:** 61/61 (ficha, histórico, ausência, orçamento, bloqueio e dia), com relógio fixo e expectativas escritas à mão. `deno check` do `index.ts`: passa.

**Hashes finais (sha256, o que a publicação envia):**

| arquivo | sha256 |
|---|---|
| `supabase/functions/ulbra-historico/index.ts` | `7476300f3dbbf10685519363728a0027ab9a0224d7be270ca806c1ad48c0fe81` |
| `supabase/functions/ulbra-historico/historico.ts` | `1355a8b08446cfe56874f44d4c766b24706acb78806aadd88255cd7706d1b93c` |
| `supabase/functions/ulbra-historico/leitura.ts` | `2bb97fa41b8d606c2b545e689c60238f984e622083d638cd48a90049a8e0067b` |

**Sequência de publicação:** ver a seção "Publicação" acima (única válida).

**Reversão:** função versão 1 em `docs/integracoes/rollback-ulbra-historico-v1/` (SHA256SUMS). Banco: o rollback da migration `20261115120000` e o rollback da `20261110100000`, este último só se a gestão decidir remover a tabela de uso.


## Atualização de 15/11/2026 (correções do parecer do Guardião 364ea36b e do head 218bdcad)

**Leitura global:** lista de dois e-mails (`amanda.seibel@aelbra.com.br`, `cobranca04@aelbra.com.br`). É decisão própria desta PR e **diverge** de `usuario_e_gestao()` em produção, que inclui a cobranca07; a cobranca07 (ADM) não tem leitura global. Não é por perfil: supervisor, gerência e administrativo fora dessa lista não leem carteira alheia. Operadores leem conversas que o servidor permite (dono da carteira ou responsável comprovado).

**Guarda da RPC:** a reserva só aceita contexto de serviço (`request.jwt.claims` com role `service_role`, ou a chave legada `request.jwt.claim.role`). Testada em PostgreSQL 17 (chamada legítima nos dois formatos; recusa de `authenticated` e de contexto ausente). **Pré-condição não comprovada:** qual formato o PostgREST do projeto injeta de fato. Só um teste em staging com PostgREST real comprova isso.

**429 e Retry-After (comportamento implementado, não contrato da ULBRA):** 429 para na hora, sem repetição. Retry-After aceito em segundos ou em data HTTP. Sem Retry-After interpretável, o bloqueio fica ativo sem prazo até a gestão limpar `historico_bloqueado_sem_prazo` em `ulbra_sync_estado`. Falha ao ler ou gravar o bloqueio fecha a chamada (não libera). **Nenhum contrato publicado pela ULBRA foi encontrado para 429 ou Retry-After**; o comportamento acima é decisão de implementação, e a gestão deve aprová-lo como tal.

**Orçamento:** saldo vencido reserva 2 (renovação + leitura) antes da primeira chamada. Testes de concorrência em PostgreSQL 17 com contador inicial lido do banco: dia vazio (150 permitidas = contador final − inicial) e dia parcialmente consumido (22 de partida; 128 permitidas; 20 + 2 + 128 = 150). A divergência anterior de 128 × 130 foi explicada: o teste esperava 150 novas permissões num dia que já tinha consumo de outros testes; o servidor estava correto.

**Testes e CI:** servidor 61/61 (Vitest); PostgreSQL 17: 11/11 (`supabase/tests/ulbra_historico_bloqueio/run.cjs`); front da tela 7/7; build de produção ok; `deno check` ok. O job `ulbra-historico-orcamento-postgres` do CI roda os testes de orçamento, bloqueio, guarda e concorrência.

**Probe de meu_acesso:** `scripts/ulbra/probe_meu_acesso.mjs`. **NÃO executado.** A credencial de backend não está no ambiente desta sessão e não foi solicitada pelo chat. Sem o resultado, o limite real da credencial continua **não comprovado**.


## Correções do parecer 8174167f (sem mudança de regra)
- **Lista divergente de produção, por decisão:** `usuario_e_gestao()` em produção inclui a cobranca07; a lista desta PR não. Não há igualdade comprovada e este texto não a alega. A decisão de alcance da ADM é da gestão.
- **Bloqueio após 429:** se a gravação do bloqueio funcionou, o banco decide em todas as instâncias, inclusive nas que já estavam quentes. Se a gravação falhou, a instância que recebeu o 429 fica fechada até conseguir gravar; as outras instâncias não ficam bloqueadas. O bloqueio não é global quando a gravação falha.
- **Liberação pela gestão:** basta limpar `historico_bloqueado_sem_prazo` no banco; não é preciso reiniciar instâncias. Teste: 429 gravado, liberação no banco, mesma instância volta a chamar a ULBRA.
- **Cache:** entradas vencidas saem a cada gravação e o total não passa de 200 entradas. Texto de conversa fica em memória só enquanto válido, por no máximo 5 minutos.
- **Regra dos cinco (exceção registrada, só para esta PR):** a #948 altera a Mensageria ULBRA e o inventário de Edge Functions. Não altera contratos da API Prime nem os três documentos Prime (`prime-api.md`, `prime-api-catalog.json`, `prime-mapa-fontes-verdade.md`). A verificação `integracoes-cinco.sh` aceita a PR só com a flag `--excecao-948`, e apenas se o diff de `docs/integracoes/` estiver dentro de `mensageria-ulbra.md`, `prime-edge-functions.md` e este pacote. Qualquer outro arquivo volta a exigir os três. A exceção não autoriza implantação nem dispensa os demais gates.

## Regra de alcance de leitura (registrada para a #948)

- **Leitura global** (qualquer carteira, com CPF confirmado): `amanda.seibel@aelbra.com.br` (gestora) e `cobranca04@aelbra.com.br` (mapeada como Fernanda — **premissa a confirmar com a gestão**).
- **cobranca07 (ADM)**: sem leitura global. Lê somente alunos da própria carteira ou atendimentos sob sua responsabilidade. Imposto no servidor, antes do cache (`index.ts`, `GESTAO_EMAILS`; `ficha.test.ts`, bloco "alcance de leitura").
- Testes: positivo (cobranca07 na própria carteira), negativo (cobranca07 em carteira alheia, sem chamada à ULBRA), positivo global (amanda.seibel).
- **Legado**: `supabase/tests/ulbra_historico_teto/reservas_simultaneas.sh` e `migracao.sql` provam o piloto antigo (limite 3, compartilhado 3). Não são o orçamento vigente (20 por usuário, 150 compartilhado, reserva 100, saldo 15 min). O orçamento vigente é provado por `ulbra-historico-orcamento-postgres` (`run.cjs`) e pelo Vitest. Nenhuma restrição de piloto foi recriada.


## Consolidação final da PR #948 (exceção, limitações e hashes)

**Limitação conhecida (R1):** o servidor revela três estados a qualquer usuário ativo com token: `403 IDENTIDADE_NAO_CONFIRMADA` (sem vínculo confirmado), `404 CONVERSA_NAO_ENCONTRADA` (sem conversa coletada) e `403 SEM_PERMISSAO_NA_CONVERSA` (com conversa, sem carteira). Isso permite inferir a existência de conversa coletada para um `aluno_id`. **Não há isolamento completo da resposta.** A resposta neutra fica como melhoria posterior, sem prometer que esconde a existência.

**Pré-condições obrigatórias (não dispensáveis por esta PR):**
1. Rotação do `ULBRA_MCP_TOKEN` concluída pela TI, com revogação do token antigo registrada.
2. Diagnóstico único de `/ulbra-diagnostico` executado por Amanda somente após a rotação, registrando só limites, saldo, escopos e data.

**Gates:** esta seção não autoriza implantação, merge, aplicação de migration ou publicação da função. Esses continuam exigindo autorização final específica.

**Hashes do head desta consolidação (sha256):**

| arquivo | sha256 |
|---|---|
| `supabase/functions/ulbra-historico/index.ts` | `7476300f3dbbf10685519363728a0027ab9a0224d7be270ca806c1ad48c0fe81` |
| `supabase/functions/ulbra-historico/historico.ts` | `1355a8b08446cfe56874f44d4c766b24706acb78806aadd88255cd7706d1b93c` |
| `supabase/functions/ulbra-historico/leitura.ts` | `2bb97fa41b8d606c2b545e689c60238f984e622083d638cd48a90049a8e0067b` |
| `supabase/functions/ulbra-historico/ficha.test.ts` | `62b275a7671ee0bfea86fdbfba04a2e6e2dc35ca7bedea788e1b18fb02fad020` |
| `supabase/functions/ulbra-historico/historico.test.ts` | `dd4f831d1a1ac7603f0fdf7cf0f5a68e30a726a1a8b2262193e58c04ca17c5a3` |
| `supabase/aguardando_aprovacao/20261115120000_ulbra_historico_bloqueio_e_guarda_reserva.sql.pendente` | `1e4bb6220994ba3f4e47f72631b0317b4acd6c63f03dbd1aee15d619560fb222` |
| `supabase/aguardando_aprovacao/20261115120000_ulbra_historico_bloqueio_e_guarda_reserva.rollback.sql` | `c076033d9ef0e6280481b8181fdda53ef4101b9cea4b13ca70e7c2493c2a736c` |
| `src/utils/ulbraHistoricoCliente.js` | `f6a1e055191d877bb310cd14fa956a26de1c803c5e82e20bfba39080658141a4` |
| `src/pages/Aluno.jsx` | `4675fca9694540b87ad920c47bc80607b8bf18080d02c19e4f67c187be3e9366` |
| `docs/integracoes/mensageria-ulbra.md` | `6a316699696f5a9e17c9724d03f292431888426fa446b257d031ba38c27f4867` |
| `docs/integracoes/prime-edge-functions.md` | `02845bd40942429a41a45462378ff5762fd84900e00fd133d42d9b5a6e52405f` |

Hashes de publicação conferidos no head: `index.ts`, `historico.ts`, `leitura.ts` (os três enviados à função). Os demais são referência de revisão.
