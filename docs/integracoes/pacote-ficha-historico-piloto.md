# Pacote: conversa da Mensageria na ficha do aluno (piloto)

**Status:** preparado. **Nada foi publicado, mesclado nem chamado na ULBRA.** Um único pacote para autorizar a publicação e o piloto.

## O que muda
- **Servidor, `ulbra-historico`:**
  - aceita `aluno_id` e resolve a conversa no servidor (a tabela de conversas continua fechada ao operador);
  - exige exatamente um vínculo ativo por CPF confirmado; sem ele, 403 antes de qualquer chamada;
  - sem conversa coletada: 404, sem chamada;
  - permissão por carteira ou responsável, como antes; sem permissão, 403 antes de qualquer chamada;
  - **teto total de 3 chamadas** (somando leituras e a renovação de saldo `meu_acesso`), checado antes de cada chamada externa;
  - 429 vira `ULBRA_LIMITE`: parada, sem nova tentativa;
  - a resposta traz `consultado_em` (data da consulta) e cada mensagem traz `em` (data da mensagem);
  - a busca de usuário por e-mail passa a ser exata (`eq`), sem `ilike`. A versão publicada hoje ainda usa `ilike`.
- **Tela:** painel `HistoricoFichaAluno` na ficha, abaixo do bloco da Mensageria. Abrir a ficha não chama a Mensageria; só o clique chama. O painel mostra "Consultado na Mensageria em <data>" e a data de cada mensagem, e diz que não é espelho salvo.
- **Porta de tela:** `HISTORICO_FICHA_PILOTO_EMAILS = []`. Nenhum operador vê o botão até a gestão nomear o piloto.

## Hashes dos arquivos que a publicação envia
| arquivo | sha256 |
|---|---|
| `supabase/functions/ulbra-historico/index.ts` | `6d5075965a1e0b17db0d0314926c684e4df2f39bea0328f62e80ecfe43570e15` |
| `supabase/functions/ulbra-historico/historico.ts` | `41ef6970152a8cc3a8788cf6375773691470ada417ae53c6d5a495be63de0998` |
| `supabase/functions/ulbra-historico/leitura.ts` (igual à main e à v1) | `20cc12d353c7278c9951208d740312831bffe92fcf2533856474be01bbb2f05f` |

Versão publicada hoje (v1), para reversão: `docs/integracoes/rollback-ulbra-historico-v1/SHA256SUMS` (`index.ts` `2e50b8de…`, `historico.ts` `4836a2e5…`, `leitura.ts` `20cc12d3…`).

## Testes executados (sem rede, com o código real)
- Servidor: `ficha.test.ts` (16 casos de handler: identidade, conversa, permissão, teto de 3, 429, data da consulta, cache) e os testes existentes de histórico e de ausência de OAuth/envio. Total do diretório: 185 testes passando.
- Front: `HistoricoFichaAluno.test.jsx` (6 casos: fora do piloto, abrir não chama, clique chama uma vez, datas, recusa, 429) e a suíte completa de componentes, páginas e utilitários: 175 arquivos, 2537 testes passando.
- Lint nos arquivos alterados: sem erros.
- `deno check`: **não executado localmente** (regra do pacote). Adicionado como job de CI `ulbra-historico-deno-check`; a publicação só deve seguir com ele verde.

## Ordem da publicação (cada passo depende de autorização)
1. Mesclar o PR de código (porta vazia: nada muda para operador).
2. Publicar `ulbra-historico` com `functions deploy` **sem** `--no-verify-jwt`. Conferir com `get_edge_function`: `verify_jwt = true` e os três hashes acima.
3. Verificação sem chamada à ULBRA: sem token, 401; aluno sem CPF confirmado, 403; ambos sem chamada.
4. **Piloto (autorização separada):** a gestão nomeia o operador em `HISTORICO_FICHA_PILOTO_EMAILS` por PR de uma linha e informa o aluno de teste.

## Piloto: teto de 3 chamadas, com parada em 429
Casos (escolhidos pela gestão com uma consulta de leitura antes):
- **A.** aluno com CPF confirmado, da carteira do operador piloto, com conversa coletada;
- **B.** aluno com CPF confirmado, de outra carteira: 403 e zero chamadas;
- **C.** aluno sem CPF confirmado: 403 e zero chamadas.

Sequência: A (1 renovação de saldo, se a medida estiver vencida, e 1 leitura), depois B e C (zero), e uma segunda leitura de A ("mensagens anteriores") se o teto permitir. Ao chegar a 3, a próxima recusa é `TETO_PILOTO_ESGOTADO`, sem chamada. Um 429 interrompe o piloto e não é repetido.

## Custo por consulta
- 1 chamada por página de 20 mensagens;
- +1 chamada quando a medida de saldo tem mais de 15 minutos (a medida atual é de 11/11).
- **Custo medido em produção: nenhum ainda.** O histórico não foi usado. O piloto mede isso.

## Limites conhecidos
- Concorrência: o teto é checado a cada chamada, mas duas requisições simultâneas podem passar juntas. O piloto é de um operador, em sequência.
- A validação na tela logada depende de uma sessão autorizada, que não tenho aqui. O operador do piloto valida.
- Caixa de e-mail: cadastro gravado com maiúscula não casa (negação segura); duplicidade só por caixa não é detectada.
