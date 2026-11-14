# Registro de divergência de hash — 20261109180000_ulbra_vinculo_leitura

Documento de registro. Não cria autorização retroativa e não altera o hash aprovado.

## Hashes aprovados (M1, commit 6275aab9 da #881)
- Arquivo `supabase/aguardando_aprovacao/20261109180000_ulbra_vinculo_leitura.sql.pendente`: 2569 bytes, com newline final.
- SHA-256: `9301c4677ce947bfb4ec7d0c8e2013fa585fad19106774ecfbd1943c0e5fc64d`.
- Rollback: 157 bytes, SHA-256 `3f553b2aaa575487d32aa2f86b0a058b68068a333871f3c6a06fd9190e1aa3f0`.

## Registro em produção
- Versão em `supabase_migrations.schema_migrations`: `20261112091901` (gerada pela ferramenta de aplicação; o arquivo usa `20261109180000`).
- Nome: `20261109180000_ulbra_vinculo_leitura`.
- Conteúdo guardado (`statements`): 1 statement; 2568 bytes de texto, sem newline final.
- SHA-256 do texto guardado: `e3a5e0abe5cd99fc827630f147545cf994d3d6e9c46d532c6e39a576bb5b9544`.
- SHA-256 do texto guardado com newline final: `9301c4677ce947bfb4ec7d0c8e2013fa585fad19106774ecfbd1943c0e5fc64d` (igual ao aprovado).

## Comparação integral
| Item | Aprovado (arquivo) | Registrado em produção |
|---|---|---|
| Bytes | 2569 | 2568 (texto) / 2572 (jsonb) |
| Newline final | sim | não |
| SHA-256 | 9301c467…fc64d | e3a5e0ab…b9544 (sem newline); 9301c467…fc64d (com newline) |
| Corpo da função `ulbra_vinculo_aluno` | md5 e92a70dd…2b49 | md5 e92a70dd…2b49 |
| Search_path | public, pg_temp | public, pg_temp |
| Grants | — | authenticated, postgres, service_role (EXECUTE) |

Conclusão: a única diferença é o newline final. O conteúdo SQL é o mesmo, byte a byte, exceto esse caractere. A função em produção tem o mesmo corpo do arquivo aprovado.

Causa provável (não comprovada por log): a ferramenta de aplicação guarda o statement sem o newline final do arquivo.

## Ações
- Não reaplicar a migration.
- Não criar autorização retroativa: a aprovação válida é a do hash `9301c467…fc64d`.
- Para aplicações futuras, registrar o hash do texto como enviado e conferir o newline final.

## Segredo ULBRA_MCP_TOKEN
Existência não verificada: os recursos disponíveis nesta sessão não listam nomes de segredos do Supabase. Ação para o responsável pelo projeto: confirmar, no painel de Edge Functions secrets, que `ULBRA_MCP_TOKEN` existe. Não exibir o valor.
