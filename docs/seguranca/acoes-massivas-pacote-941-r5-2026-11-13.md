# Ações massivas: pacote da #941 + R5 + otimização (13/11/2026)

Status: **não aplicado em produção.** Nenhuma migration aplicada, nenhuma massiva disparada.
Nenhuma execução do universo pesado em produção.

## Cadeia de dependências (três artefatos)

| # | Artefato | Entrada (MD5) | Saída (MD5) | Situação |
|---|---|---|---|---|
| 0 | Publicado hoje (#935) | — | `8f94a1687f0f3d13765ecf86db1d1e19` | em produção |
| 1 | #941: valor e faixa, `20261112235500` | `8f94a168…` | `52f8ca6c4e4428e9dc5d0912e2b9751a` | **NÃO é definitivo**: a sessão da #941 ainda tem alterações não commitadas |
| 2 | R5 v2, `20261112235600` (este pacote) | `52f8ca6c…` | `885583bc6a45d7e3c77d7add841ac11b` | testada (26/26), não aplicada |
| 3 | Otimização (desempenho) | `885583bc…` | a definir | **sem sessão identificada nesta conversa**; hash de entrada transferido aqui |

Regra: a otimização deve ser ancorada em `885583bc…`. Não aplicar uma otimização ancorada no corpo antigo (`78e55b9a…`, obsoleto).

Ordem de aplicação: 1 → 2 → 3. Rollback na ordem inversa; cada rollback confere o hash de entrada.

## Commits (worktree `fix/acoes-massivas-r5-integrado`, sem push)

- `f6424128`: #941 publicada (base)
- `be63c81c`: R5 integrada (v1, **substituída**)
- `3e2483e3`: pacote (v1, **substituído**)
- próximo commit: R5 v2 + este pacote revisado

## Testes: resultado verificável

- Arquivo: `supabase/tests/acoes_massivas_r5_sobre_valor.test.js`
- Execução final: migration **completa** (sem corte), 26/26, exit 0
- Log: `tasks/r5final2.output` (execução única iniciada após a interrupção anterior)
- Linha de base da #941 (sem R5): 35/35 (`acoes_massivas_valor_exigivel.test.js`, execução anterior)

### O que os testes cobrem (e o que não cobrem)

Cobrem, com execução real em PGlite:
- sem caso: com evidência entra; boleto não confiável fica fora; pagamento de 5 dias atrás fica fora
- caso encerrado antigo com saldo positivo: não autoriza sozinho; com evidência entra
- total_em_aberto nulo: não autoriza sozinho; com evidência entra
- caso aberto com saldo positivo: não autoriza sozinho; com evidência entra
- cada evidência R5: saldo zero, renegociada, pagamento casado pelo boleto, Prime pelo CPF, parcela gêmea
- correções: pagamento sem aluno casado pelo boleto bloqueia; boleto com zero à esquerda; titulo EM_CONFIRMACAO com o mesmo documento
- anos: parcela sem R5 de outro ano não contribui com o ano do aluno só-parcela
- valor: só-parcela soma só a parcela comprovada; total do caso não muda o valor
- vencimento futuro não autoriza
- ACL: anon sem EXECUTE; authenticated mantém EXECUTE (`has_function_privilege`)
- marcador da guarda final presente na migration

**Não cobrem (pendências declaradas):**
- o teste de `anon` testa o caminho permitido e negado de anon; PUBLIC não é testado diretamente
- fronteira de data (venc −10 dias) depende do fuso da sessão; sem teste de fronteira
- schema: o stub de `prime_extrato` usado no teste (colunas `cpf`, `boleto`, `liquidado_em` adicionadas no teste) pode divergir do schema de produção; o schema real não foi conferido nesta rodada
- universo completo em produção: não medido
- consumidores com fixtures próprias: não executados contra esta definição

## Correções feitas nesta rodada (frente aos 9 achados do Guardião)

Ver tabela no fim deste documento.

## Pacote de recuperação (incidente de timeout)

1. Aplicar 1 (#941) só após a sessão da #941 consolidar o código final e fixar o hash.
2. Aplicar 2 (R5 v2) com MD5 de entrada `52f8ca6c…` conferido.
3. Aplicar 3 (otimização) com MD5 de entrada `885583bc…`.
4. Validação limitada após cada passo: prévia com **um** recorte pequeno (um responsável, um ano), timeout explícito, sem exportar nem registrar.
5. Não rodar o universo completo enquanto o incidente de timeout estiver aberto.

## Bloqueios restantes

- **Sessão da #941 não identificada** nesta conversa: a consolidação do código final depende dela.
- **Otimização não identificada**: o hash de entrada está definido; a migração de desempenho não existe neste worktree.
- **Portador 166**: a regra está documentada (premissa 6 de `docs/PREMISSAS.md`: 195 ainda cobra, 166 saiu da cobrança, ausência de portador = quitou). A R5 usa **evidência positiva** de liquidação (`prime_extrato.liquidado_em`), não a ausência de linhas. Não foi usada ausência de linhas para concluir quitação.
- **Decisão de negócio pendente**: valor de alunos com titulo ou mensalidade continua somando todas as parcelas vencidas do acordo (comportamento da #941). Só o caminho só-parcela foi restringido.
- **Consumidores**: ver a seção de testes.

## Achados do Guardião (v1, be63c81c) e situação

| # | Achado | Situação |
|---|---|---|
| 1 | Pagamento sem aluno escapa | Corrigido: pagamento sem aluno casado por boleto bloqueia. Teste. |
| 2 | Boleto com zero à esquerda | Corrigido: comparação normalizada em pagamentos, prime_extrato e gêmea. Teste. |
| 3 | Portador 166 (cobertura da liquidação Prime) | Parcial: regra documentada; a R5 não usa ausência de linhas. Decisão de negócio sobre a cobertura do 166 **pendente**, sem presumir inclusão ou exclusão. |
| 4 | Valor não protegido | Corrigido no caminho só-parcela (valor = parcelas comprovadas). Caminhos de titulo e mensalidade **pendentes de decisão**. Teste. |
| 5 | Grants não reconferidos | Parcial: ACL do universo conferida por teste de execução (anon negado, authenticated permitido). PUBLIC não testado diretamente. |
| 6 | Testes com overclaim | Corrigido: lista de cobertura acima substitui a frase anterior. |
| 7 | EM_CONFIRMACAO não excluído | Corrigido: o titulo EM_CONFIRMACAO com o mesmo documento bloqueia. Teste. |
| 8 | anos contaminado | Corrigido: parcela sem R5 não contribui com ano para aluno só-parcela. Teste. |
| 9 | Encerrado com duas definições | Corrigido: a base não usa mais `encerrado_operacional`; o caso não autoriza sozinho. Testes. |

Achados 10, 11 e 12 da v1 (CPF vazio, fronteira de data, schema de teste): CPF vazio corrigido (`regexp_replace <> ''`); fronteira de data e schema **pendentes**.
