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

Saldo medido hoje: **9.821**, medido em **11/11/2026**. Esse valor está antigo: a primeira consulta depois da publicação renova o saldo com uma chamada `meu_acesso`, que conta no orçamento do usuário que consultou.

**Dimensionamento (14/11/2026, leitura de produção, somente leitura):**
- 7 operadores (perfil `operador`): até 20 chamadas por usuário/dia cada; pior caso 140.
- 3 de gestão (`supervisor`, `gerencia`, `administrativo`): acesso amplo; até 20 chamadas cada; pior caso 60.
- 4 de outros perfis (`carteira`, `diretoria`, `juridico`, `painel`): leem só quando são dono da carteira ou responsáveis pelo atendimento; até 20 cada; pior caso 80.
- Pior caso por usuário: 280 chamadas/dia. O teto compartilhado de 150/dia limita o total real.

**O que conta no orçamento compartilhado:** toda chamada que consome cota da ULBRA: leitura de histórico, renovação de saldo (`meu_acesso`) e tentativa, inclusive a que falha depois da reserva. Nenhuma delas é contada como 'leitura' à parte.

**Compatibilidade com coleta e demais funções:** não comprovada. A reserva de 100 não garante capacidade para a coleta: o saldo é uma foto do dia e a coleta consome do mesmo saldo. Antes da publicação, o consumo real da coleta precisa ser lido e comparado com o saldo medido.

**Ponto em aberto que muda o número:** a ULBRA mediu 500 chamadas/dia por pessoa na conexão OAuth do piloto, e não confirmou se o limite vale também para a credencial de backend (que é o que o histórico usa). Se valer, o orçamento compartilhado precisa caber nesse teto junto com a coleta. O teto de 150 é uma proposta: não há prova de que ele caiba no cenário de 500/dia por pessoa, porque isso depende de a ULBRA confirmar o limite. A confirmação é uma chamada de `meu_acesso` com a credencial de backend (1 chamada, sob orçamento aprovado).

**Saldo medido:** 9.821 em 11/11/2026, defasado. Não é usado para decidir; a primeira consulta depois da publicação renova o saldo.

**Pergunta para aprovação:** confirmar, alterar ou recusar os cinco valores (operador/dia 20, reserva 100, validade 15 min, teto diário 150) e autorizar a chamada única de `meu_acesso` para confirmar o limite da credencial de backend. Até a aprovação, a publicação usa os valores acima exatamente como estão no código.

## Proteções
- **Concorrência:** o orçamento é reservado no banco, por dia, com trava. Teste em Postgres isolado com o SQL real: 6 cliques de um operador com limite de 3 deixam 3 aprovados; 8 operadores com orçamento de 3 deixam 3 aprovados e 5 negados.
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
- Servidor: 192 testes passam no diretório da função.
- Front: 175 arquivos e 2538 testes passam; lint sem erros nos arquivos alterados.
- Postgres isolado com reservas simultâneas: job `ulbra-historico-teto-postgres`.
- `deno check` da função: job `ulbra-historico-deno-check`.

## Hashes dos arquivos que a publicação envia
| arquivo | sha256 |
|---|---|
| `supabase/functions/ulbra-historico/index.ts` | `a9d8a5f20ee15446816fe06114fed9e3a01a118d00b06aeb5314fff921fac093` |
| `supabase/functions/ulbra-historico/historico.ts` | `ab3aac759ae76146391a4f5cc3dab24a181131dd58c0a4af5ff225697c654f38` |
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
