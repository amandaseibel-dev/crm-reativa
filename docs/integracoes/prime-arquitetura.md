# Arquitetura da integração Prime/ULBRA

Diagrama lógico: quem chama quem, o que é leitura, o que é escrita, e onde
estão os pontos cegos. Ver [README.md](README.md) para o índice.

```
                                   ┌─────────────────────────────┐
                                   │   Prime/ULBRA API (externa)  │
                                   │  prime-api.ulbra.ai/api      │
                                   │  SOMENTE LEITURA (allow: GET)│
                                   └───────────────┬──────────────┘
                                                    │ X-API-Key (Vault)
                        ┌───────────────────────────┼───────────────────────────┐
                        │                            │                           │
                 LEITURA DE CADASTRO         LEITURA FINANCEIRA          SONDAGEM / DIAGNÓSTICO
                        │                            │                           │
         ┌──────────────┼──────────────┐   ┌─────────┼─────────┐      ┌──────────┼──────────┐
         │              │              │   │         │         │      │          │          │
   prime-sync     prime-cadastro  prime-titular  prime-portador  prime-extrato  prime-sonda  prime-diagnostico
         │              │         prime-buscar-nome    │              │              │              │
         │              │              │          │    │              │              │        (1 chamada
         ▼              ▼              ▼          │    ▼              ▼              ▼         de cada tipo,
   prime_cadastro_sync  alunos    (sem grava-     │  prime_portador_  prime_extrato  resposta = │  não grava)
   (espelho)         (complementa) ção; devolve   │  membro,          (espelho)      FORMA, não
                      só vazio)    p/ revisão)     │  prime_sync_                      conteúdo
                                                    │  cursor                          (cru:true
                                          modo pontual  (varredura                      p/ conferir)
                                          (confirma 166 completa e
                                           ao vivo)     confirma)
                                                    │
                                                    ▼
                                       RPCs de CONCILIAÇÃO
                                  conciliacao_vincular_identidade_por_cpf
                                  conciliacao_registrar_consulta_estrutura
                                  conciliacao_liquidar_titulo_por_prime  ◄── ÚNICO caminho de
                                  conciliacao_confirmar_portador_166          ESCRITA financeira
                                                    │                         que a integração
                                                    ▼                         Prime alimenta
                                       pagamentos / parcelas / acordos
                                       (banco ReATIVA — escrita SEMPRE
                                        via RPC com trava de negócio,
                                        nunca update direto)

   ┌─────────────────────────────────────────────────────────────────────────┐
   │  prime-acordo — sonda dedicada: varre o composto atrás de "quem fechou   │
   │  o acordo". Só leitura, nunca grava. Resultado: a API não expõe isso.    │
   └─────────────────────────────────────────────────────────────────────────┘

   ┌─────────────────────────────────────────────────────────────────────────┐
   │  exportar-gestao — NÃO fala com a Prime. Exporta dado JÁ derivado dela   │
   │  (revisao_prime_aluno) em lote, para bucket privado com URL assinada.    │
   └─────────────────────────────────────────────────────────────────────────┘
```

## Caminhos de leitura

1. **Cadastro** — `prime-sync`/`prime-cadastro` → `student_composite` →
   `alunos` (só completa campo vazio, nunca sobrescreve).
2. **Extrato financeiro** — `prime-extrato` → `financial_statement` (via
   composto) → `prime_extrato` (espelho bruto, sem decidir vínculo).
3. **Filiação a portador** — `prime-portador` (varredura completa, paginada
   com cursor) → `prime_portador_membro`.
4. **Diagnóstico/sondagem** — `prime-diagnostico` (smoke test) e `prime-sonda`
   (rota arbitrária) — nunca gravam, só respondem na hora.

## Caminho de escrita financeira (o único que existe)

`prime-portador`, no **modo pontual**, é o único ponto onde uma leitura da
Prime pode terminar em **escrita financeira** no CRM — e só através de RPCs
com trava própria:

```
pagamento sem vínculo
   │
   ▼
1. conciliacao_vincular_identidade_por_cpf   (resolve DE QUEM é o pagamento,
   │                                           só por CPF exato — nunca por nome)
   ▼
2. GET /students/{reg}/agreements             (tentativa oficial; SE responder
   │                                           com item, PARA aqui — grava em
   │                                           auditoria, não mapeia campo)
   ▼ (vazio)
3. GET /students/{reg}/financial-statement    (o título original foi liquidado
   │                                           direto, sem passar por acordo?)
   ▼ (não)
4. conciliacao_liquidar_titulo_por_prime      (se achou título 195 liquidado —
   │                                           TERMINAL: não segue para o 166)
   ▼ (não achou)
5. busca no portador 166 (confirma negociação, NUNCA estrutura)
   │
   ▼
6. conciliacao_confirmar_portador_166         (promove o caso para
                                                "negociação confirmada sem
                                                 estrutura" — nunca cria
                                                 acordo/parcela por aqui)
```

Cada etapa tem um resultado ERRO/ENCONTRADA/NAO_ENCONTRADA gravado antes de
decidir se segue — falha técnica nunca vira conclusão de negócio (ver o código
de `prime-portador/index.ts`, seção "modo pontual").

## Pontos cegos (onde a arquitetura hoje não enxerga)

| Ponto cego | Onde dói | Mitigação atual |
|---|---|---|
| **Estrutura financeira do acordo** — parcelas, valor negociado, situação | Todo fluxo que precisa saber "quantas parcelas tem esse acordo e quanto falta" | Nenhuma automática. Teste de consistência auto-verificável (Premissa 20) só CONFIRMA, nunca RECONSTRÓI |
| **Quem fechou o acordo / quais mensalidades ele substituiu** | Atribuição de caso, auditoria de operador | Aproximação pelo último operador do histórico (nunca a fonte real) |
| **Status do acordo** (quebrado/renegociado/cancelado) na Prime | Saber se um acordo do CRM ainda vale | Só a tela humana do Prime mostra; sem API |
| **Vínculo explícito acordo × mensalidade substituída** | Evitar dobra de cobrança | Reconstrução por assinatura (aluno+data), teto ALTA_CONFIANÇA, nunca automática sem revisão |
| **Tabelas/RPC só em produção** (`prime_chave_api`, `prime_extrato`, `prime_extrato_fila`) | Reprodutibilidade — ninguém consegue recriar o ambiente do zero a partir do repositório | Nenhuma; ver `prime-gaps.md` |
| **Rotina que alimenta `prime_extrato_fila`** | Não encontrada em `src/` nem em Edge Functions do repo — provavelmente SQL/cron direto em produção | Nenhuma; investigar antes de depender dela |

Ver [prime-gaps.md](prime-gaps.md) para a versão tabular VERDE/AMARELO/VERMELHO
de cada um desses pontos.
