-- Aluno sem telefone E sem e-mail entra na fila da Prime -- e na frente.
--
-- Amanda, 28/08/2026: "tem algum lugar que consiga um banco de dados para
-- atualizar os telefones dos alunos?" -- e: "todos os alunos tem e-mail
-- redeulbra cadastrado".
--
-- O BANCO JA EXISTE e e a Prime: a coleta traz telefone e e-mail e ja gravou
-- 7.036 contatos, o ultimo hoje. O mecanismo funciona.
--
-- O QUE NAO FUNCIONA e quem ela busca:
--     3.589 alunos nao tem telefone NEM e-mail -- inalcancaveis por qualquer
--           canal, e zero contato guardado
--     3.216 desses NUNCA foram consultados na Prime
--
-- O motivo: `prime_cadastro_pendentes` so considera quem tem TITULO EM ABERTO
-- com saldo (CTE `devedores`). A prioridade "sem telefone" ordena DENTRO desse
-- conjunto -- entao quem nao tem titulo em aberto nunca chega a ser consultado,
-- por mais inalcancavel que esteja.
--
-- SOBRE O E-MAIL INSTITUCIONAL: no CRM so 2.984 de 17.473 alunos tem
-- @rede.ulbra, e 4.608 nao tem e-mail nenhum. Se a Ulbra cadastra e-mail para
-- todo aluno, esse dado nao chegou ate nos -- e a Prime e o caminho, ja que a
-- coleta traz e-mail junto do telefone.
--
-- AGORA: quem esta sem telefone e sem e-mail entra mesmo sem divida, e vai para
-- o TOPO. Aluno sem contato nenhum nao pode ser trabalhado por ninguem -- nem
-- por operador, nem por acao massiva. Destravar isso vem antes de tudo.
--
-- ORDEM FINAL, do mais urgente para o menos:
--   1. sem contato nenhum   -> nao da para falar com ele de jeito nenhum
--   2. cadastro repetido    -> destrava conferencia de duplicidade
--   3. sem telefone         -> tem e-mail, mas falta o canal principal
--   4. 2026 / sem negociacao
--   5. recuperados          -> destrava a medicao de conversao
--   6. maior saldo
--
-- Conferido apos aplicar: dos 60 do proximo lote, 50 entram so por falta de
-- contato -- nao teriam vez pelo criterio de divida.

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
           bool_or(extract(year from t.vencimento) = 2026) AS tem_2026
      FROM public.acordos_titulos t
     WHERE lower(coalesce(t.status,'')) = 'em_aberto'
       AND upper(coalesce(t.situacao,'')) = 'ABERTO'
       AND coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
       AND length(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g')) = 11
     GROUP BY 1
  ),
  -- SEM CONTATO NENHUM: nem telefone, nem e-mail, nem contato guardado.
  sem_contato AS MATERIALIZED (
    SELECT DISTINCT lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') AS cpf
      FROM public.alunos a
     WHERE length(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g')) = 11
       AND coalesce(a.telefone,'') = ''
       AND coalesce(a.email,'') NOT LIKE '%@%'
       AND NOT EXISTS (SELECT 1 FROM public.aluno_contatos c WHERE c.aluno_id = a.id)
  ),
  repetidos AS MATERIALIZED (
    SELECT DISTINCT lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') AS cpf
      FROM public.alunos a
     WHERE length(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g')) = 11
       AND length(coalesce(a.nome,'')) > 12
       AND EXISTS (
         SELECT 1 FROM public.alunos b
          WHERE b.id <> a.id
            AND length(coalesce(b.nome,'')) > 12
            AND upper(regexp_replace(translate(b.nome,
                  'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
                  'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'), '\s+', ' ', 'g'))
              = upper(regexp_replace(translate(a.nome,
                  'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
                  'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'), '\s+', ' ', 'g'))
       )
  ),
  recuperados AS MATERIALIZED (
    SELECT DISTINCT lpad(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g'), 11, '0') AS cpf
      FROM public.casos c
      JOIN public.alunos al ON al.id = c.aluno_id
     WHERE c.quitado_em IS NOT NULL
       AND length(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g')) = 11
    UNION
    SELECT DISTINCT lpad(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g'), 11, '0')
      FROM public.baixas_pagamento b
      JOIN public.parcelas p ON p.id = b.parcela_id
      JOIN public.acordos a  ON a.id = p.acordo_id
      JOIN public.alunos al  ON al.id = a.aluno_id
     WHERE b.status_baixa = 'REALIZADA'
       AND length(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g')) = 11
  ),
  candidatos AS MATERIALIZED (
    SELECT d.cpf, d.saldo, d.tem_2026 FROM devedores d
    UNION
    SELECT sc.cpf, 0::numeric, false FROM sem_contato sc
     WHERE NOT EXISTS (SELECT 1 FROM devedores d0 WHERE d0.cpf = sc.cpf)
    UNION
    SELECT r.cpf, 0::numeric, false FROM repetidos r
     WHERE NOT EXISTS (SELECT 1 FROM devedores d2 WHERE d2.cpf = r.cpf)
    UNION
    SELECT rc.cpf, 0::numeric, false FROM recuperados rc
     WHERE NOT EXISTS (SELECT 1 FROM devedores d3 WHERE d3.cpf = rc.cpf)
  ),
  ja_coletados AS MATERIALIZED (
    SELECT DISTINCT c.cpf FROM public.prime_contratos c
     WHERE c.coletado_em > now() - interval '7 days'
  ),
  sem_telefone AS MATERIALIZED (
    SELECT DISTINCT lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') AS cpf
      FROM public.alunos a
     WHERE coalesce(a.telefone,'') = ''
       AND length(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g')) = 11
  )
  SELECT c.cpf, c.saldo
    FROM candidatos c
    LEFT JOIN sem_negociacao s ON s.cpf = c.cpf
    LEFT JOIN ja_coletados j   ON j.cpf = c.cpf
    LEFT JOIN sem_telefone st  ON st.cpf = c.cpf
    LEFT JOIN sem_contato sc2  ON sc2.cpf = c.cpf
    LEFT JOIN repetidos r      ON r.cpf = c.cpf
    LEFT JOIN recuperados rc   ON rc.cpf = c.cpf
   WHERE j.cpf IS NULL
   ORDER BY (sc2.cpf IS NOT NULL) DESC,  -- 1) sem contato nenhum: inalcancavel
            (r.cpf IS NOT NULL) DESC,    -- 2) cadastro repetido
            (st.cpf IS NOT NULL) DESC,   -- 3) sem telefone
            c.tem_2026 DESC,
            (s.cpf IS NOT NULL) DESC,
            (rc.cpf IS NOT NULL) DESC,   -- 5) recuperados: destrava a medicao
            c.saldo DESC
   LIMIT greatest(1, least(coalesce(p_limite, 50), 500));
$function$;
