# Preservação: ulbra-historico v1 (produção, ahattpqrjmhkzsmnbdzs)

- Função: ulbra-historico, id 700063b4-12a6-4bc8-a3c5-f820378c2ffd, versão 1, ACTIVE, verify_jwt=true
- Criada em: 1794483401900 (epoch ms); última atualização: 1794483401900
- ezbr_sha256 do pacote publicado: 56d22bdbfe655053ff5ac8f4f7bcdb5f337e3ed45ee6201be8ed062fbbd343ca
- Origem: get_edge_function (somente leitura), em 2026-11-16.
- Conteúdo: três arquivos, reconstruídos fielmente a partir do retorno da leitura. Os hashes por arquivo (SHA256SUMS.txt) são dos arquivos aqui gravados. O ezbr_sha256 é o hash do pacote inteiro, não dos arquivos; por isso ele não confirma a cópia por arquivo.
- Diferença conhecida em relação à branch feat/ulbra-historico-e-resposta: index.ts importa "../ulbra-conversa/leitura.ts" em produção, e a branch importa "./leitura.ts". Preserva-se o que está publicado.
- Não é a versão a restaurar. Esta versão expõe histórico de conversa com a credencial central, sem a porta de tela e sem auditoria.

## Registro na repositório
- Esta cópia é a referência durável, versionada no repositório, do código publicado em produção em 2026-11-16 (sem credenciais).
- CONTENÇÃO CONCLUÍDA (confirmada pela gestão): a função `ulbra-historico` foi excluída pelo painel do Supabase, após o download do ZIP desta cópia. Verificado: função ausente da listagem e endpoint respondendo HTTP 404. Não há restauração. Esta cópia é apenas referência; não é código publicado.
- Os testes da v1 (`historico.test.ts.ref`, `ausencia.test.ts.ref`) saíram do `supabase/functions/` e estão preservados como referência em `functions/ulbra-historico/`. Têm extensão `.ref` para que o Vitest não os execute: não são testes do sistema atual, e checam código antigo da v1.
