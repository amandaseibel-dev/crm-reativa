-- Quem não tem telefone entra na frente da fila da Prime.
--
-- Amanda, 26/08/2026, depois de ver a Ação Massiva render pouco: "3962"
-- (alunos sem telefone) e "consegue consultar no prime se novos numeros".
--
-- O PROBLEMA. A varredura da Prime já traz telefone junto -- é ela que alimenta
-- os contatos novos. Mas a fila não sabia quem precisava: ordenava por 2026,
-- depois por saldo. Medido: dos 3.958 alunos sem telefone e disponíveis para
-- ação, apenas 105 tinham sido consultados. 3.853 ainda não.
--
-- Sem telefone o aluno não entra em ação massiva, não recebe mensagem, não é
-- acionado -- está fora da operação inteira. É a perda isolada mais cara: 36%
-- da base útil (3.962 de 10.887 disponíveis).
--
-- A MUDANÇA. Uma linha na ordenação:
--
--   1. sem telefone      <- novo, e é o que destrava a ação massiva
--   2. tem parcela 2026  <- prioridade pedida hoje de manhã
--   3. já sincronizado
--   4. maior saldo
--
-- Não muda ritmo, custo nem nada da coleta: muda só a ORDEM. No ritmo atual
-- (841 por hora) os 3.853 devem estar cobertos em ~5 horas, em vez de esperar
-- a varredura inteira dos 17.470.
--
-- Aluno sem CPF utilizável (65 casos) continua fora -- não há como consultar.
--
-- Conferido logo após aplicar: os próximos 200 da fila são 200 sem telefone,
-- somando R$ 711.243,69 de saldo.

create or replace function public.prime_cadastro_pendentes(p_limite integer default 50)
returns table(cpf text, saldo numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  WITH sem_negociacao AS MATERIALIZED (
    SELECT DISTINCT e.cpf FROM public._relatorio_2026_1_eleg() e
  ),
  devedores AS MATERIALIZED (
    SELECT lpad(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g'), 11, '0') AS cpf,
           round(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)), 2) AS saldo,
           -- Prioridade da Amanda: quem tem parcela de 2026 em aberto vem antes.
           bool_or(extract(year from t.vencimento) = 2026) AS tem_2026
      FROM public.acordos_titulos t
     WHERE lower(coalesce(t.status,'')) = 'em_aberto'
       AND upper(coalesce(t.situacao,'')) = 'ABERTO'
       AND coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
       AND length(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g')) = 11
     GROUP BY 1
  ),
  ja_coletados AS MATERIALIZED (
    SELECT DISTINCT c.cpf FROM public.prime_contratos c
     WHERE c.coletado_em > now() - interval '7 days'
  ),
  -- Sem telefone o aluno esta fora da operacao inteira: nao entra em acao
  -- massiva, nao recebe mensagem, nao e acionado. Consultar ele primeiro e o
  -- que devolve gente para a fila de trabalho.
  sem_telefone AS MATERIALIZED (
    SELECT DISTINCT lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') AS cpf
      FROM public.alunos a
     WHERE coalesce(a.telefone,'') = ''
       AND length(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g')) = 11
  )
  SELECT d.cpf, d.saldo
    FROM devedores d
    LEFT JOIN sem_negociacao s ON s.cpf = d.cpf
    LEFT JOIN ja_coletados j   ON j.cpf = d.cpf
    LEFT JOIN sem_telefone st  ON st.cpf = d.cpf
   WHERE j.cpf IS NULL
   ORDER BY (st.cpf IS NOT NULL) DESC, d.tem_2026 DESC, (s.cpf IS NOT NULL) DESC, d.saldo DESC
   LIMIT greatest(1, least(coalesce(p_limite, 50), 500));
$function$;

comment on function public.prime_cadastro_pendentes(integer) is
  'Fila da varredura da Prime. Ordem: sem telefone primeiro (aluno sem telefone esta fora da operacao inteira), depois parcela 2026, depois ja sincronizado, depois maior saldo. Nao muda ritmo nem custo -- muda so quem e consultado antes.';
