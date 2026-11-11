# Pacote — Mensageria de novembro na Central (equipe Reativa)

Preparado em 11/11/2026 para aprovação da gestão. **Nenhuma chamada à ULBRA foi feita** na preparação; nada aplicado nem publicado.

## O que entrega
1. **Coleta por período** (`ulbra-sincronizar`, nova versão a publicar): corpo da chamada manual aceita `desde` (limite inferior; data pura = meia-noite de Brasília; máx. 120 dias) e `detalhes` (1..20 leituras de `ler_conversa` por execução). Com `desde`, a leitura para na página em que o piso passa do início e o ciclo fecha como COMPLETO; depois disso a coleta é incremental a partir do topo. Equipe: só Reativa (recorte no código, como hoje).
2. **Consulta nova** `ulbra_central_conversas(p_desde, p_operador, p_limite, p_pagina)` — migration `20261111120000_ulbra_central_conversas_periodo` (pendente): conversas da equipe Reativa no período (padrão: mês corrente em Brasília), **mais recente primeiro**, com direção da última mensagem (`recebida` do aluno / `enviada` pela equipe) e `aguardando`. Só CPF confirmado (vínculo ativo `alta_cpf`); sem CPF vai **só como contagem** para a gestão. Recorte igual ao da Central: operador vê os próprios casos, gestão tudo ou o operador do filtro; inativo e painel negados. `security definer`, `search_path` fixo, EXECUTE só `authenticated`.
3. **Tela**: a Central ganha a visão **Mensageria (período)** — seção 1 respostas de alunos aguardando atendimento (mais antiga primeiro), seção 2 demais conversas do período (mais recente primeiro, com direção) — e a **Carteira interna** fica em visão separada e nomeada. "Abrir ficha" só com `aluno_id`. A tela declara: histórico completo e resposta pelo CRM **não** disponíveis; só o que a última coleta trouxe.

## O que a API permite (lido do contrato, sem chamada)
- `listar_conversas`: filtros `canal`, `situacao`, `cliente`, `pagina`, `limite ≤ 50`. **Não filtra por equipe nem por data.** Ordem global por última mensagem, mais nova primeiro (medido em 08/11).
- Consequência: para "novembro, equipe Reativa" lê-se a caixa inteira (todas as equipes) de cima para baixo até passar de 01/11; a equipe e o período são recortados no código. **O custo é dominado pelo volume das outras equipes.**
- Paginação sem perda: janela `cursor/pendente/topo` + fechamento do grupo de mesmo horário + `offset_pendente` (já em produção); `desde` só acrescenta o limite inferior. Mensagens que chegam entre execuções são lidas primeiro (regra existente).

## Saldo e consumo real
- `ulbra_sync_estado`: `saldo_api_restam = 1` medido às 07:02 de 10/11 (coleta). O reset diário da ULBRA não é conhecido por nós.
- As **fichas** consomem a mesma cota (credencial de backend): auditoria registra 09/11 ≈ 250 chamadas (216 vínculos criados + 22 consultas + bloqueios), 10/11 ≈ 120, 11/11 ≈ 20 até as 08h. Isso explica o saldo 1 de ontem e limita qualquer coleta durante o expediente.
- A função já aborta (`PULADO_ORCAMENTO`) quando o saldo não cobre; `meu_acesso` é consultado no início (1 chamada, cache de 60 min).

## Estimativa de volume e teto proposto
- Medido em 08/11: 3 páginas (150 conversas, todas as equipes) cobriram ~22,5 h; 7 eram da Reativa (~5%).
- Novembro 01→11 (10,5 dias): ≈ 1.650 conversas ativas no total ⇒ **≈ 34 páginas**; Reativa ≈ 80 conversas (incerteza alta: ±50%).
- Detalhe (`ler_conversa`) só quando a última mensagem não é do aluno e é recente (`precisa_detalhe`), até 5 por execução ⇒ ≈ 40.
- Custo estimado: 34 + 40 + 1 (`meu_acesso`) + 1 (`listar_atendimentos`) ≈ **76**. **Teto proposto: 110 chamadas** (folga de ~45%), em ≈ 9–10 execuções de até 12 leituras (HARD_LEITURAS), com parada automática por saldo.
- **Condição de início**: `meu_acesso` com `restam ≥ 300` (110 + ≥ 190 para as fichas do dia) e horário **antes das 08:00 de Brasília**. Se `restam < 300`, não executa e informa.
- **Cobertura esperada**: conversas WhatsApp **ativas** da equipe Reativa com última mensagem ≥ 01/11 (Brasília), com nome, direção, prévia e data. **Fora**: encerradas/arquivadas em novembro (`situacao ≠ active` — segunda passada opcional, ~mesmo custo), e-mail, e conversas sem CPF confirmado (só contagem; vínculo nasce pela ficha).

## Ordem de execução (após aprovação única)
1. Merge da PR (tela + função + migration no repositório). Deploy automático da tela.
2. Linha M1 para `20261111120000` (hash abaixo) em PR própria; `apply_migration` com o arquivo inteiro; conferir grants e `search_path`; ledger.
3. Publicar `ulbra-sincronizar` (nova versão) — `--no-verify-jwt`, como hoje.
4. Coleta: `meu_acesso` → se `restam ≥ 300`, execuções manuais com corpo `{"teto_chamadas":12,"desde":"2026-11-01","detalhes":5}` até `ciclo = COMPLETO` ou 110 chamadas; registrar cada execução (chamadas, páginas, conversas) no doc oficial.
5. Validar a visão Mensageria com a gestão e com um operador (login próprio).

## Hashes
- `20261111120000_ulbra_central_conversas_periodo.sql.pendente`: sha256 `a768ffca80e1ec0bd663392ffa5f4b51c581564add8c69f691c7c345d7a406ed`
- `.rollback.sql` (drop da função): sha256 `b259866944c29d3e3d1efb4f86bd8a91f69dad1c9a58d1f06f1c645b50727a45`

## Paradas
Hash divergente; saldo abaixo da condição; `FALHA` em duas execuções seguidas; qualquer escrita fora de `ulbra_*`; impacto fora do escopo.

## Fora deste pacote
Histórico completo na Central, resposta pelo CRM (exige conexão individual OAuth), coleta automática (cron), agente de estratégia. **Decisão pendente, recomendada:** a consulta da Mensageria ao abrir a ficha passar a ser sob demanda (botão), para proteger a cota.
