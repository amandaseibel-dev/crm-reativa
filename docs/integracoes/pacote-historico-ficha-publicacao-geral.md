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
- 3 de gestão (lista de três e-mails ativos, a mesma de `usuario_e_gestao()`; não é por perfil): acesso amplo; até 20 chamadas cada; pior caso 60.
- 4 de outros perfis (`carteira`, `diretoria`, `juridico`, `painel`): leem só quando são dono da carteira ou responsáveis pelo atendimento; até 20 cada; pior caso 80.
- Pior caso por usuário: 280 chamadas/dia. O teto compartilhado de 150/dia limita o total real.

**O que conta no orçamento compartilhado:** toda chamada que consome cota da ULBRA: leitura de histórico, renovação de saldo (`meu_acesso`) e tentativa, inclusive a que falha depois da reserva. Nenhuma delas é contada como 'leitura' à parte.

**Compatibilidade com coleta e demais funções:** não comprovada. A reserva de 100 não garante capacidade para a coleta: o saldo é uma foto do dia e a coleta consome do mesmo saldo. Antes da publicação, o consumo real da coleta precisa ser lido e comparado com o saldo medido.

**Ponto em aberto que muda o número:** a ULBRA mediu 500 chamadas/dia por pessoa na conexão OAuth do piloto, e não confirmou se o limite vale também para a credencial de backend (que é o que o histórico usa). Se valer, o orçamento compartilhado precisa caber nesse teto junto com a coleta. O teto de 150 é uma proposta: não há prova de que ele caiba no cenário de 500/dia por pessoa, porque isso depende de a ULBRA confirmar o limite. A confirmação é uma chamada de `meu_acesso` com a credencial de backend (1 chamada, sob orçamento aprovado).

**Saldo medido:** 9.821 em 11/11/2026, defasado. É usado no teto de saldo (fotografia guardada pela coleta); a primeira consulta depois da publicação renova o saldo.

**Pergunta para aprovação:** confirmar, alterar ou recusar os cinco valores (operador/dia 20, reserva 100, validade 15 min, teto diário 150) e autorizar a chamada única de `meu_acesso` para confirmar o limite da credencial de backend. Até a aprovação, a publicação usa os valores acima exatamente como estão no código.

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
| `supabase/functions/ulbra-historico/index.ts` | `bff338315e122883d19999a2e96c9875d05f41f41575baf60ee596da9e6a119a` |
| `supabase/functions/ulbra-historico/historico.ts` | `ad3598d12ff3f1156ba0a1627b6438c6c54c634a22c813092dbb227b7fbee39d` |
| `supabase/functions/ulbra-historico/leitura.ts` (igual à v1) | `20cc12d353c7278c9951208d740312831bffe92fcf2533856474be01bbb2f05f` |

## Publicação (cada passo com autorização)
1. Aprovação dos quatro valores acima e do pacote.
2. Mesclar a #948 (clique humano).
3. Publicar `ulbra-historico` com `functions deploy`, **sem** `--no-verify-jwt`. Conferir `verify_jwt = true` e os três hashes.
4. Conferir sem chamada à ULBRA: sem token dá 401; aluno sem CPF confirmado dá 403.
5. Validação com operadores reais na tela logada, feita pela gestão.

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

**Testes do servidor:** 57/57 (ficha, histórico, ausência, orçamento, bloqueio e dia), com relógio fixo e expectativas escritas à mão. `deno check` do `index.ts`: passa.

**Hashes finais (sha256, o que a publicação envia):**

| arquivo | sha256 |
|---|---|
| `supabase/functions/ulbra-historico/index.ts` | `bff338315e122883d19999a2e96c9875d05f41f41575baf60ee596da9e6a119a` |
| `supabase/functions/ulbra-historico/historico.ts` | `ad3598d12ff3f1156ba0a1627b6438c6c54c634a22c813092dbb227b7fbee39d` |
| `supabase/functions/ulbra-historico/leitura.ts` | `20cc12d353c7278c9951208d740312831bffe92fcf2533856474be01bbb2f05f` |

**Sequência de implantação (cada passo depende de aprovação sua):**
1. Aprovar os valores (20 por usuário, 150 compartilhados, reserva 100, saldo 15 min) e esta versão.
2. Aplicar a migration `20261115120000` (com o rollback pronto). Comando seu: `psql -1 -f supabase/aguardando_aprovacao/20261115120000_ulbra_historico_bloqueio_e_guarda_reserva.sql.pendente`.
3. Mesclar a #948 (clique seu no GitHub).
4. Publicar `ulbra-historico` com a verificação de JWT ligada: `supabase functions deploy ulbra-historico --project-ref ahattpqrjmhkzsmnbdzs` (sem `--no-verify-jwt`). Conferir os três hashes acima.
5. Conferir sem chamar a ULBRA: sem token dá 401; aluno sem CPF confirmado dá 403.
6. Validação com operadores e gestão na tela logada.

**Ponto ainda não comprovado:** se o limite de 500/dia por pessoa vale para a credencial de backend. O probe de `meu_acesso` (uma chamada, sob sua autorização) responde isso; ele não foi executado por esta sessão.

**Reversão:** função versão 1 em `docs/integracoes/rollback-ulbra-historico-v1/` (SHA256SUMS). Banco: o rollback da migration `20261115120000` e o rollback da `20261110100000`, este último só se a gestão decidir remover a tabela de uso.


## Atualização de 15/11/2026 (correções do parecer do Guardião 364ea36b e do head 218bdcad)

**Gestão:** a gestão é a lista dos três e-mails ativos (`amanda.seibel@aelbra.com.br`, `cobranca04@aelbra.com.br`, `cobranca07@aelbra.com.br`), a mesma lista de `usuario_e_gestao()` em produção. Não é por perfil: supervisor, gerência e administrativo fora dessa lista não leem carteira alheia. Operadores leem conversas que o servidor permite (dono da carteira ou responsável comprovado).

**Guarda da RPC:** a reserva só aceita contexto de serviço (`request.jwt.claims` com role `service_role`, ou a chave legada `request.jwt.claim.role`). Testada em PostgreSQL 17 (chamada legítima nos dois formatos; recusa de `authenticated` e de contexto ausente). **Pré-condição não comprovada:** qual formato o PostgREST do projeto injeta de fato. Só um teste em staging com PostgREST real comprova isso.

**429 e Retry-After (comportamento implementado, não contrato da ULBRA):** 429 para na hora, sem repetição. Retry-After aceito em segundos ou em data HTTP. Sem Retry-After interpretável, o bloqueio fica ativo sem prazo até a gestão limpar `historico_bloqueado_sem_prazo` em `ulbra_sync_estado`. Falha ao ler ou gravar o bloqueio fecha a chamada (não libera). **Nenhum contrato publicado pela ULBRA foi encontrado para 429 ou Retry-After**; o comportamento acima é decisão de implementação, e a gestão deve aprová-lo como tal.

**Orçamento:** saldo vencido reserva 2 (renovação + leitura) antes da primeira chamada. Testes de concorrência em PostgreSQL 17 com contador inicial lido do banco: dia vazio (150 permitidas = contador final − inicial) e dia parcialmente consumido (22 de partida; 128 permitidas; 20 + 2 + 128 = 150). A divergência anterior de 128 × 130 foi explicada: o teste esperava 150 novas permissões num dia que já tinha consumo de outros testes; o servidor estava correto.

**Testes e CI:** servidor 57/57 (Vitest); PostgreSQL 17: 11/11 (`supabase/tests/ulbra_historico_bloqueio/run.cjs`); front da tela 7/7; build de produção ok; `deno check` ok. O job `ulbra-historico-orcamento-postgres` do CI roda os testes de orçamento, bloqueio, guarda e concorrência.

**Probe de meu_acesso:** `scripts/ulbra/probe_meu_acesso.mjs`. **NÃO executado.** A credencial de backend não está no ambiente desta sessão e não foi solicitada pelo chat. Sem o resultado, o limite real da credencial continua **não comprovado**.


## Correções do parecer 8174167f (sem mudança de regra)
- **Lista de gestão igual à de produção, por evidência:** `usuario_e_gestao()` em produção (catálogo somente leitura, 15/11/2026) tem md5(prosrc) `889cfa4a82e9046b4322e8c85ee07b7d` (o mesmo registrado em `supabase/ledger/2026-10/INDICE.tsv`) e lista exatamente os três e-mails de `GESTAO_EMAILS`. Permanece limitação: se a lista mudar em produção, o código precisa mudar junto.
- **Bloqueio após 429:** se a gravação do bloqueio funcionou, o banco decide em todas as instâncias, inclusive nas que já estavam quentes. Se a gravação falhou, a instância que recebeu o 429 fica fechada até conseguir gravar; as outras instâncias não ficam bloqueadas. O bloqueio não é global quando a gravação falha.
- **Liberação pela gestão:** basta limpar `historico_bloqueado_sem_prazo` no banco; não é preciso reiniciar instâncias. Teste: 429 gravado, liberação no banco, mesma instância volta a chamar a ULBRA.
- **Cache:** entradas vencidas saem a cada gravação e o total não passa de 200 entradas. Texto de conversa fica em memória só enquanto válido, por no máximo 5 minutos.
- **Regra dos cinco:** a exceção para a Mensageria é decisão da gestão, já registrada no README de integrações.
