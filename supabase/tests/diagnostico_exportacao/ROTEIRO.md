# Roteiro reproduzível — exportação de Ações Massivas

Diagnóstico somente. Não altera produção, não altera migrações históricas e não contém dados de alunos.

## O que está versionado

| Arquivo | Conteúdo | Origem / verificação |
|---|---|---|
| `fixtures/acoes_massivas_exportar/prod_20261115_definicao_vigente.sql` | `acoes_massivas_exportar` | pg_get_functiondef em produção, 15/11/2026; MD5 `c9cc7498…` |
| `fixtures/producao/registrar_acao_massiva_2026-11-15.sql` | `registrar_acao_massiva` | produção, 15/11/2026; MD5 `6eb41bf1…` |
| `fixtures/producao/usuario_e_gestao_e_motivo_texto_2026-11-15.sql` | `usuario_e_gestao`, `acoes_massivas_motivo_texto` | produção, 15/11/2026; MD5 `af3d391f…`, `d12cf7a6…` |
| `fixtures/acoes_massivas_valor_exigivel/prod_20261112_universo_pos_dono_do_acordo.sql` | `acoes_massivas_universo` (estado pré-#941) | produção; MD5 `8f94a168…` |
| `fixtures/acoes_massivas_valor_exigivel/prod_20261113_tipo_cobranca_alunos.sql` | `acoes_massivas_tipo_cobranca_alunos` | produção; MD5 `323628b7…` |
| `diagnostico_exportacao/reproducao.mjs` | roteiro executável (PGlite, dados fictícios) | — |

Os MD5 são conferidos pelo próprio roteiro antes de qualquer teste: se uma definição divergir, ele para.

## Como rodar

```bash
GESTORA_CLAIM=<identidade-da-lista-fixa-de-usuario_e_gestao> node supabase/tests/diagnostico_exportacao/reproducao.mjs
```

A identidade vem do ambiente e não fica no repositório. Ela precisa estar na lista fixa de `usuario_e_gestao` em produção; sem isso o gate recusa, como em produção.

## O que a reprodução mostra (e o que não mostra)

- Mostra que, com as definições de produção, as dependências verificadas e o papel `authenticated` com `statement_timeout = 8s`, a prévia (100 alunos) e a exportação (100 contatos, 100 registros, 1 lote) rodam sem erro neste volume.
- Repetição com a mesma prévia e os mesmos alunos: nenhum registro novo. O aluno saiu pelo motivo `retorno_futuro`, porque a primeira exportação agendou retorno em +10 dias.
  - Isso **não é idempotência garantida**. Ele depende do efeito colateral de tabulação. Não recomendar repetir uma exportação após resposta perdida sem reconciliar antes com o histórico de lotes.
- **Não é prova de desempenho em produção.** Os tempos isolados (dezenas de milissegundos) não são comparáveis aos da prévia em produção, que levou 25,2 s. A latência de produção segue sem causa demonstrada.
- Não reproduz a resposta da RPC pelo navegador, nem o volume, os índices e a distribuição reais de produção. A base tem apenas as colunas usadas pela cadeia, com tipos de produção, e os índices verificados; não é o esquema completo.

## Limites conhecidos

- `usuario_e_gestao` em produção é uma lista fixa de três e-mails. Ela não existe em nenhuma migração do repositório. Qualquer mudança de acesso precisa ser tratada como tal.
- A definição de `acoes_massivas_exportar` em produção tem `statement_timeout` de 120 s; o repositório tem 60 s em migrações anteriores. Não igualar arquivos alterando o timeout produtivo.

## Procedência das fixtures

Todas foram lidas de `pg_get_functiondef` do projeto de produção em 15/11/2026, por consulta somente de leitura. Nenhuma foi escrita em produção. O roteiro confere o MD5 da definição carregada antes de qualquer teste.

| Fixture | Finalidade | MD5 do arquivo | MD5 da definição (produção) |
|---|---|---|---|
| `acoes_massivas_exportar/prod_20261115_definicao_vigente.sql` | exportação (RPC que registra o lote) | `ca7c385a…` | `c9cc7498…` |
| `producao/registrar_acao_massiva_2026-11-15.sql` | registro das movimentações e tabulação | `2514e411…` | `6eb41bf1…` |
| `producao/usuario_e_gestao_e_motivo_texto_2026-11-15.sql` | gate de gestão e textos de motivo | `ad26d5d8…` | `af3d391f…` (gate), `d12cf7a6…` (motivo) |
| `acoes_massivas_valor_exigivel/prod_20261112_universo_pos_dono_do_acordo.sql` | universo (estado pré-#941) | `a17abb74…` | `8f94a168…` |
| `acoes_massivas_valor_exigivel/prod_20261113_tipo_cobranca_alunos.sql` | tipo de cobrança (estado pré-#941) | `ac641ead…` | `323628b7…` |

**Sobre os e-mails na fixture de gate.** A lista fixa de `usuario_e_gestao` contém três e-mails institucionais. Eles já estão versionados nas migrações do repositório e fazem parte da definição de produção. Foram mantidos para que o MD5 da fixture seja idêntico ao de produção. Isso **não é exceção de segurança**: nenhuma credencial, token ou dado de aluno está na fixture. A identidade usada pelo roteiro vem de `GESTORA_CLAIM` e não é gravada no repositório.

**Sobre recarregar a página.** Recarregar reinicia a interface. Não comprova o estado do lote no servidor. Depois de resultado incerto, a única forma de saber se o lote foi registrado é conferir o histórico de lotes, e o roteiro não recomenda repetir a exportação sem essa conferência.
