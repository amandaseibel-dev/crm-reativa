# Pacote de publicação — histórico sob demanda (#913) — PREPARADO, NÃO EXECUTADO

Fonte: branch `feat/ulbra-historico-e-resposta`, head `9d750005` (CI em andamento).
Escopo: histórico somente leitura. Fora: conexão individual e envio (`20261111140000`) e OAuth.

## 1. Artefatos (SHA-256 no head `9d750005`)
| Arquivo | SHA-256 | Bytes |
|---|---|---|
| supabase/aguardando_aprovacao/20261110100000_ulbra_historico_orcamento.sql.pendente | 163f3b551bd62f18dca519310b76e0cb58d78f4235bde7cff7ff7210bc82622b | 2620 |
| supabase/aguardando_aprovacao/20261110100000_ulbra_historico_orcamento.rollback.sql | 1aa486a119b5fe86e2fc8b304308ff1f784b22db9094946e52ecd775cd18b801 | 201 |
| supabase/functions/ulbra-historico/index.ts | 2e50b8de076ae048834cdf810d0053790691142b29432a59f9020112442f1e79 | 8880 |
| supabase/functions/ulbra-historico/historico.ts | 4836a2e5173c4eca17d25add216dbd4cd9428a02eb86037f98342f0ec597d36c | 7488 |
| supabase/functions/ulbra-conversa/leitura.ts (dependência importada) | 20cc12d353c7278c9951208d740312831bffe92fcf2533856474be01bbb2f05f | 4023 |
| supabase/functions/ulbra-conversa/cripto.ts (dependência importada) | 3363e6220580ab70db784bfef6aa188feadaf4b2f3a460a649a4c7988c7f775a | 2208 |

## 2. Migration 20261110100000
- Cria `ulbra_historico_uso` (RLS ligado; revoke de public, anon, authenticated; grant select/insert/update só para service_role).
- Cria `ulbra_historico_reservar(...)`: security definer, `search_path = public, pg_temp`; execute só para service_role.
- Não toca grants de tabelas existentes.
- Estado em produção (12/11): ausente. Precisa de M1 própria (ver `autorizacao-m1-20261110100000.md`).

## 3. Rollback
Ver `autorizacao-m1-20261110100000.md`. Reverter a Edge Function antes do rollback. O rollback apaga `ulbra_historico_uso` se houver registros.

## 4. Função Edge `ulbra-historico`
- `verify_jwt = true`; portão: cadastro ativo; vínculo `alta_cpf` lido no banco; permissão = dono da carteira, responsável comprovado ou perfil amplo (supervisor, gerencia, administrativo).
- Orçamento reservado no banco antes de cada chamada à ULBRA (`ulbra_historico_reservar`).
- Saldo: fotografia de `meu_acesso` com validade de 15 min (`SALDO_VALIDADE_MS`); só consulta `meu_acesso` se a fotografia estiver vencida, reservando antes.
- Credencial de backend somente leitura; nada de texto de mensagem gravado; nenhum envio.
- Pré-condição: segredo da ULBRA definido no projeto. LIMITAÇÃO: esta conferência não pôde ser feita aqui (CLI `supabase` não instalado e as ferramentas disponíveis não listam nomes de segredos sem expor valores). Fica pendente de conferência pelo responsável do projeto, apenas pela existência, sem exibir valor.

## 5. Ordem de publicação (cada etapa com aprovação própria)
1. M1 da `20261110100000` (esta PR).
2. Aplicar a migration e conferir tabela, função e grants: service_role sim; authenticated, anon e public não.
3. Publicar a Edge Function `ulbra-historico` (com `ulbra-conversa` como dependência).
4. Só então publicar o frontend da Central que chama a função. Sem a função, a tela mostra erro e não quebra.

## 6. Teto do teste controlado: 3 chamadas à ULBRA
Discriminação:
| # | Cenário | Chamadas à ULBRA | Justificativa |
|---|---|---|---|
| 1 | Operador responsável lê uma conversa elegível | 1 `ler_conversa` | necessária: prova a leitura autorizada |
| 2 | Operador alheio tenta a mesma conversa | 0 | negado antes da reserva; conferir que a contagem de `ulbra_historico_uso` não muda |
| 3 | Gestão lê outra conversa elegível | 1 `ler_conversa` | necessária: prova o perfil amplo |
| 4 | Fotografia de saldo vencida | até 1 `meu_acesso` | só se a fotografia estiver com mais de 15 min; evitável se o saldo estiver fresco |
Total máximo: 3. Se uma quarta chamada for necessária, o teste para e informa; não é executada sem nova aprovação. Paginação não é usada: uma página de 20 mensagens por leitura.

## 7. Critérios de conversa elegível (somente leitura do banco; nenhuma chamada externa)
- `ulbra_conversas` com `aluno_status = 'vinculado'` e vínculo `alta_cpf` ativo no aluno.
- Para o cenário 1: `responsavel_ulbra` ou `alunos.responsavel_atual_email` igual ao operador de teste aprovado.
- Para o cenário 3: perfil de gestão aprovado.
- Última mensagem nos últimos 7 dias (há conteúdo para ler).
- Fora de conferência e sem divergência de identidade.
- Escolhida e aprovada pelo responsável antes do teste; sem dados pessoais no relatório (só o identificador interno).

## 8. Pendências
- Conexão individual e envio: separadas, dependem de OAuth por operador.
- Conferência do segredo da ULBRA: pendente (ver item 4).
