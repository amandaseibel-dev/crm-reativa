# Giro total das carteiras 2026/1 e 2026/2 — desenho (16/10/2026)

**Estado: DESENHO + SIMULAÇÃO MEDIDA. Nada foi aplicado em produção.** Este
documento é o levantamento estrutural e as decisões que precisam da sua palavra
antes de qualquer execução.

**A simulação já rodou** (16/10/2026, somente SELECT, pelo SQL Editor de
produção). Resultados, relatório por operador e o que não é distribuído:
[`GIRO-CARTEIRAS-2026-1-2026-2-SIMULACAO.md`](GIRO-CARTEIRAS-2026-1-2026-2-SIMULACAO.md).
As decisões 1 a 4 abaixo estão atualizadas com o que a medição mostrou.

---

## 1. O motor pedido já existe — e está desativado

`calibragem_simular_giro_2026(jsonb)` +
`calibragem_executar_giro_lote_impl(uuid,int)`
(`supabase/migrations/20260910120000_giro_carteira_2026.sql`) fazem quase
exatamente o que a tarefa pede:

| O que a tarefa pede | O que o motor já faz |
|---|---|
| CPF como unidade, nunca dividir um CPF | `cpf_chave` = CPF limpo, e `'caso:'||id` quando o CPF é vazio (não colapsa os vazios num bucket só) |
| Quantidade igual de CPFs e valor equilibrado | Serpentina: ordena por valor desc e distribui em zigue-zague; resto cai nos primeiros slots |
| Entre operadores ativos, sem gestão/administrativo/desligado | `usuarios.ativo and perfil = 'operador'` |
| Não preservar fidelização | o giro ignora os 10 dias de propósito (`ignora_fidelizacao: true`) |
| Não alterar acordos | aluno com parcela de acordo em aberto fica fora do giro inteiro |
| Registrar anterior, novo, data e identificador do giro | `calibragem_auditoria` (`regra = 'GIRO_2026'`, `simulacao_id`) + `historico_operadores_alunos` |
| Execução transacional e reversível | execução em lotes com `pg_advisory_xact_lock`; reversão por `calibragem_desfazer_nivelamento_lote` |
| Simulação antes de aplicar | grava RASCUNHO em `calibragem_simulacoes`; só executa se `APROVADA` |
| Teto de 500 casos por operador não atrapalha | `set_config('calibragem.bypass_teto','on',true)` |

**Mas as duas portas recusam a chamada desde 29/09/2026**
(`20260929101600_giro_2026_desativar_execucao.sql`): um `raise exception ...
errcode 42501` com a marca `GIRO_DESATIVADO` foi inserido no topo das duas
funções, com a justificativa "não haverá novo giro". A premissa mudou: há um
novo giro. **Reativar é uma decisão sua, não um detalhe de implementação** — e
precisa de migration (patch ancorado, removendo o bloco pela âncora, não
reescrevendo a função).

O giro de 10/09 (simulação `c7c49f02-6e85-436b-a606-8f27945f8334`, 4.218 casos)
fica intacto: o histórico não é tocado.

## 2. Origem correta de cada dado (estrutura real, pelas migrations)

| Informação | Onde mora | Observação |
|---|---|---|
| Saldo de mensalidade por aluno | view `calibragem_saldo_aluno.saldo_mensalidade` | soma de `acordos_titulos` com `situacao='ABERTO'`, `status='em_aberto'`, `acordo_id is null`, sem vínculo ativo em `acordo_titulo_vinculo` e não superado por acordo (`titulo_superado_por_acordo`). Valor = `coalesce(saldo_corrigido, valor_em_aberto, valor_original)` |
| Saldo de acordo por aluno | `calibragem_saldo_aluno.saldo_acordo` | parcelas abertas de acordo não cancelado |
| Título (a unidade de mensalidade) | `acordos_titulos` | `tipo_boleto <> 'Acordo'` é mensalidade; `'Acordo'` é parcela renegociada que virou título. Honorário **não** é título (vive como `valor_honorario` em pagamentos), então "honorário isolado" não entra por construção |
| Semestre do título | `prime_titulo_semestre.semestre` (oficial) **ou** mês de vencimento | ver Decisão 1 |
| Responsável do caso | `casos.operador_email` / `operador_nome` / `operador` (maiúsculas) | 34 funções escrevem este campo |
| Responsável da mensalidade | `casos.operador_mensalidade_email` / `_nome` / `mensalidade_girada_em` | colunas criadas para o giro de 10/09 |
| Responsável da ficha | `alunos.responsavel_atual_email` | sincronizado nos dois sentidos por `trg_sync_alunos_apos_casos` → `internal.set_resp_aluno` e por `_sync_casos_resp_aluno` |
| Fidelização (regra viva, v1) | `caso_dentro_prazo_fidelizacao(casos.data_ultimo_acionamento)` = `dua + 10 >= current_date` | |
| Fidelização v2 (por dono) | `casos.fidelizacao_inicio` | **NÃO existe em produção** (medido 16/10): a migration de 30/09 nunca foi aplicada. Só a v1 está viva |
| Operadores que recebem | `usuarios` com `ativo`, `perfil='operador'`, `recebe_novos_casos` | 7 operadores, todos recebendo — ver Decisão 4 |
| Auditoria do giro | `calibragem_auditoria`, `calibragem_simulacoes` | |

## 3. O risco que decide o desenho: a titularidade nova é revertida *amanhã*

O giro **não** mexe em `casos.data_ultimo_acionamento`. Então o caso muda de
dono carregando o relógio antigo de acionamento. O cron
`fidelizacao_liberar_vencidos` (`20 8 * * *`, 08:20 UTC) roda
`liberar_casos_fidelizacao_vencida()` **sem limite** (`coalesce(p_limite,
100000)`) sobre `casos_elegiveis_liberacao_fidelizacao()`.

Consequência: sem fidelização especial, na primeira manhã seguinte ao giro o
cron devolve ao pool praticamente todo caso redistribuído cujo último
acionamento seja anterior a 10 dias. **O giro se desfaz sozinho em algumas
horas.** A fidelização excepcional do item 4 da tarefa não é um enfeite: é o
que sustenta o giro.

## 4. Decisões que precisam da sua palavra

### Decisão 1 — de onde vem "competência 2026/1 / 2026/2"

Duas fontes, e elas **não** concordam:

* **Vencimento** (jan–jun = 2026/1, jul–dez = 2026/2). É o que o giro de 10/09 e
  os classificadores `carteira_2026_1/2_classificar()` usam.
* **`prime_titulo_semestre.semestre`**, que vem da janela do contrato da série
  na Prime. A documentação oficial da integração diz, textualmente, que o
  semestre "vem da janela do contrato da SERIE, nao do mes do vencimento — e o
  que faz a matricula antecipada cair no semestre certo". Cobertura parcial: só
  os boletos já coletados da Prime.

Além disso, o giro de 10/09 classificava o **CPF inteiro** pelo vencimento mais
recente em aberto (`venc_max`), o que faz um CPF que deve nos dois semestres
contar só em 2026/2. O relatório que você pediu tem colunas separadas para
"CPFs 2026/1" e "CPFs 2026/2" **e** "CPFs únicos totais" — isso só faz sentido
com semestre **por título**, não por CPF.

**Recomendação:** semestre por título, `prime_titulo_semestre` quando existir e
vencimento como fallback. Um CPF com dívida nos dois semestres conta nas duas
colunas e continua com **um** operador só (medido: 59 CPFs nessa situação).

**Medido em 16/10.** Cobertura do Prime: 97,2% dos 40.789 títulos em aberto. No
recorte de 2026 os dois métodos concordam em 10.774 títulos e divergem em
1.232. O híbrido adotado dá 12.147 títulos / R$ 18.099.144,99; só por
vencimento seriam 12.640 / R$ 17.810.564,48 — saem 795 títulos que vencem em
2026 mas são de contrato de 2025, entram 302 de matrícula antecipada. A tabela
cruzada completa está na simulação, seção 4.2. **Se você preferir vencimento
puro, é só dizer: muda o universo, não o algoritmo.**

### Decisão 2 — aluno com acordo ativo entra no giro?

O giro de 10/09 deixava fora quem tem qualquer parcela de acordo em aberto. Há
uma regra de 13/09 em produção — "o dono do acordo é o responsável" (trigger
`_aluno_segue_dono_do_acordo`) — e mover esses casos entra em conflito com ela,
que é um caminho automático capaz de reverter a titularidade por fora da guarda
de `casos`.

**Recomendação:** manter fora e reportá-los como "não distribuídos, com
justificativa", que é o que o item 5 da tarefa prevê. Entram no giro apenas
CPFs com mensalidade 2026/1-2026/2 em aberto e sem parcela de acordo em aberto.

**Medido em 16/10:** são 1.040 alunos / 1.961 títulos / R$ 4.724.081,83 — 26%
do saldo do universo. É o maior grupo fora do giro, então vale a decisão ser
consciente, não automática.

### Decisão 3 — mecanismo da fidelização até 26/10 (inclusive)

| Opção | Como | Custo |
|---|---|---|
| **A** — escrever `data_ultimo_acionamento = 2026-10-16` | zero código novo: a regra viva (`dua + 10 >= current_date`) protege exatamente até 26/10 | sobrescreve o relógio real de acionamento em milhares de casos e faz todo relatório que lê esse campo ("Meu dia", sem-acionamento, efetividade) ler o giro como se fosse acionamento |
| **B** — coluna nova `casos.giro_fidelizacao_ate` + guarda | guarda dentro de `liberar_fidelizacao_caso` (a ponta única que solta o caso, onde já existe uma guarda de fidelização) e nos dois montadores de pool automáticos | uma migration a mais; preserva o histórico intacto |

**Recomendação: B.** O campo `data_ultimo_acionamento` é prova operacional, não
espaço de rascunho — e você já pediu para preservar o histórico. A coluna
precisa ser criada: `casos.fidelizacao_inicio`, da v2, **não existe em
produção**, então não há onde pegar carona.

**Medido em 16/10, o tamanho do risco:** o giro entrega 3.943 casos; **525 já
estão hoje fora da janela de 10 dias** e seriam soltos pelo cron
`fidelizacao_liberar_vencidos` (ativo, sem limite de lote) na primeira manhã.
Nos dias seguintes o número cresce sozinho.

Sobre 27/10: em qualquer das duas opções, o que a regra normal libera naquele
dia é exatamente o caso que **ninguém trabalhou** em 10 dias — acionamento
válido do novo dono reescreve `dua` e renova a janela por mais 10 dias a partir
dele. A expiração **não** dispara giro nem nivelamento (o giro fica desativado
de novo depois desta rodada, e o nivelamento respeita a janela). Mas é honesto
dizer: se a carteira não for trabalhada, há um volume grande ficando elegível
no mesmo dia. A simulação vai dizer quantos casos e quanto valor isso
representa no pior caso.

### Decisão 4 — quem recebe

`ativo and perfil = 'operador'` é o filtro do giro de 10/09. Existe também
`usuarios.recebe_novos_casos`, que o giro **não** olhava.

**Recomendação:** exigir `coalesce(recebe_novos_casos, true)` — quem está
marcado para não receber caso novo não deveria receber fatia de giro.

**Medido em 16/10: a decisão não muda nada hoje.** Os 7 operadores ativos
(Luana, Mauricio, Nataly, João, Allan, Rafaella, Diego) estão todos com
`recebe_novos_casos` verdadeiro. Fica como proteção para o dia em que não
estiverem. Olga não aparece: está inativa.

### Decisão 5 — o teto de 500 (surgiu da medição, ainda em aberto)

`trigger_impor_teto_operador` está ativo e libera o excedente acima do teto a
cada troca de dono. Depois do giro os 7 operadores ficam entre 568 e 634 casos
**ativos**, todos acima de 500 (tabela completa na simulação, seção 4.4).

A migration ensina o gatilho a não escolher caso dentro da fidelização do giro,
mas isso só desloca o alvo: o excedente passa a cair sobre a carteira antiga do
operador. Para o giro caber, o teto precisa subir para pelo menos 650 —
`calibragem_definir_teto(700, null)`.

**DECIDIDO em 16/10: sobe para 700.** A migration faz a mudança
(`calibragem_definir_teto(700, null)`), declarando o estado anterior — 500,
posto por migration em 30/07 — para reversão. É a única mudança de regra geral
do arquivo, e está lá porque sem ela o giro não para de pé.

O executor também passa a **recusar** o giro se qualquer operador estiver com
teto abaixo do necessário, a cada lote: assim o giro não roda em silêncio sob um
teto que o desfaria. Fica o alerta para depois: voltar a 500 com a carteira
nesse tamanho devolve ao pool cerca de 740 casos na primeira troca de dono.

### Decisão 6 — bloqueio nas ações massivas (16/10)

**Decidido: os alunos do giro saem de TODA ação massiva até 26/10.**
`acoes_massivas_universo(jsonb)` é a fonte única — prévia, exportar, drilldown,
cobertura, matriz de camadas e `registrar_acao_massiva` passam por ela,
conferido em produção. Um motivo novo de indisponibilidade (`giro_fidelizado`)
bloqueia prévia, seleção, exportação e registro de uma vez, inclusive as
externas.

A fidelização excepcional **não** é renovada por ação massiva: ela é data fixa
em coluna própria, e só o executor do giro a escreve. Ação massiva escreve
`data_ultimo_acionamento`, que é outro campo — e com o bloqueio o aluno nem
entra na ação.

**Limite declarado:** o bloqueio governa a seleção de ação massiva. Acordo do
mesmo CPF segue intacto — criação, parcelas, quitação, baixa e a cobrança do
acordo não passam por essa função. Quem tinha acordo ativo nem entrou no giro.

### Decisão 7 — o que acontece em 27/10 (16/10)

**Decidido: ninguém volta ao pool.** A partir de 27/10, sem nenhuma rotina
rodar:

* o aluno reaparece nas ações massivas (a flag compara com a data);
* qualquer operador ativo pode assumir o caso pelo fluxo normal, mesmo ele
  tendo dono, e sem depender da janela de 10 dias;
* até alguém assumir, responsável e histórico seguem intactos;
* quem assume limpa a marca, e o caso volta inteiro à regra normal.

Para isso a guarda da liberação automática e a do teto olham a **marca**
(`giro_fidelizacao_ate is not null`), não a data: é o que impede o cron de
devolver os casos ao pool em 27/10. Já o bloqueio das massivas e a permissão de
assumir olham a **data**.

**Risco declarado:** enquanto ninguém assumir, esses casos ficam fora do rodízio
automático dos 10 dias — por desenho, porque foi pedido preservar o responsável.
Se a intenção for que voltem ao rodízio em algum momento, isso precisa de uma
decisão a mais; hoje a saída é alguém assumir.

## 5. O que será escrito na execução (quando autorizada)

* `casos.operador_email`, `operador_nome`, `operador` — o responsável.
* `casos.operador_mensalidade_email`, `_nome`, `mensalidade_girada_em` — a
  titularidade da mensalidade.
* `alunos.responsavel_atual_email` — por **sincronismo** do trigger, não por
  escrita direta. **Verificar em produção:** o sync zera
  `alunos.data_ultimo_acionamento` na troca de dono; se o caminho de liberação
  usar o relógio mais recente entre `casos` e `alunos`, isso muda o cálculo da
  fidelização. Item de verificação, não suposição.
* `casos.giro_fidelizacao_ate = '2026-10-26'` (Decisão 3B).
* `calibragem_auditoria` — uma linha por caso movido, com operador anterior,
  novo, valor, motivo, `regra`, `simulacao_id` (= identificador do giro) e data.
* `historico_operadores_alunos` — o rastro na ficha.

Nada de acordo, pagamento, baixa, termo ou valor financeiro é tocado.

**Reversão:** `calibragem_desfazer_nivelamento_lote` desfaz pelo
`simulacao_id`, devolvendo cada caso ao dono anterior registrado na auditoria.
Sem PITR no projeto (restrição conhecida), a reversão é essa — por id exato,
não restore.

## 6. Ordem de execução proposta

1. ~~Restaurar a leitura de produção.~~ **Feito** (SQL Editor, 16/10).
2. ~~Rodar a simulação.~~ **Feito** — resultados em
   [`GIRO-CARTEIRAS-2026-1-2026-2-SIMULACAO.md`](GIRO-CARTEIRAS-2026-1-2026-2-SIMULACAO.md).
3. **Pendente: você decide 1 a 4 e aprova os números.**
4. Só então: migration (reativação do giro + universo novo + fidelização
   especial), simulação gravada como RASCUNHO em `calibragem_simulacoes`,
   aprovação, execução em lotes.

Nenhum merge, nenhuma migration e nenhuma alteração em produção antes da sua
autorização expressa.
