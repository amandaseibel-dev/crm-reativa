-- A fila de coleta passa a respeitar quem o Prime nao conhece.
--
-- Fecha o par com 20260831080000: aquela migration criou o registro da tentativa,
-- esta faz a fila LER esse registro. Sem as duas juntas, a coleta volta a pedir
-- as mesmas pessoas a cada 2 minutos e trava assim que o topo da fila for so
-- gente que o Prime nao devolve -- 27% dos lotes medidos em 31/08.
--
-- Unica diferenca para 20260831070000: o NOT EXISTS contra
-- prime_cadastro_sem_retorno no final. O resto e identico.
--
-- DESFAZER: supabase/rollbacks/20260831070000_prime_coleta_100_por_cento.rollback.sql
-- (volta ao formato antigo; leia os avisos de la antes)

create or replace function public.prime_cadastro_pendentes(p_limite integer default 50)
returns table(cpf text, saldo numeric)
language sql
stable security definer
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
  -- NUNCA COLETADO: nao existe nenhuma linha dele em prime_contratos.
  -- E o unico grupo do qual nao sabemos nada -- por isso vem primeiro.
  nunca_coletado AS MATERIALIZED (
    SELECT DISTINCT lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') AS cpf
      FROM public.alunos a
     WHERE length(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g')) = 11
       AND NOT EXISTS (
         SELECT 1 FROM public.prime_contratos c0
          WHERE c0.cpf = lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0'))
  ),
  -- SEM CONTATO NENHUM: nem telefone, nem e-mail, nem contato guardado.
  -- Nao da para falar com ele por canal algum. Entra sem divida.
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
  sem_telefone AS MATERIALIZED (
    SELECT DISTINCT lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') AS cpf
      FROM public.alunos a
     WHERE coalesce(a.telefone,'') = ''
       AND length(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g')) = 11
  ),
  -- As prioridades viajam como coluna e sao resolvidas num GROUP BY so.
  -- `e_fonte` separa quem PODE entrar na fila (os cinco grupos) de quem so
  -- carrega prioridade (sem telefone, sem negociacao) -- estes nao entram
  -- sozinhos, so reordenam quem ja entrou. O HAVING garante isso.
  candidatos AS MATERIALIZED (
    SELECT u.cpf,
           max(u.saldo) AS saldo,
           bool_or(u.tem_2026)   AS tem_2026,
           bool_or(u.e_nunca)    AS e_nunca,
           bool_or(u.e_sem_cont) AS e_sem_cont,
           bool_or(u.e_repetido) AS e_repetido,
           bool_or(u.e_recup)    AS e_recup,
           bool_or(u.e_sem_tel)  AS e_sem_tel,
           bool_or(u.e_sem_neg)  AS e_sem_neg
      FROM (
        SELECT d.cpf, d.saldo, d.tem_2026,
               false, false, false, false, false, false, true
          FROM devedores d
        UNION ALL SELECT n.cpf, 0::numeric, false, true,  false, false, false, false, false, true FROM nunca_coletado n
        UNION ALL SELECT s.cpf, 0::numeric, false, false, true,  false, false, false, false, true FROM sem_contato s
        UNION ALL SELECT r.cpf, 0::numeric, false, false, false, true,  false, false, false, true FROM repetidos r
        UNION ALL SELECT v.cpf, 0::numeric, false, false, false, false, true,  false, false, true FROM recuperados v
        UNION ALL SELECT t.cpf, 0::numeric, false, false, false, false, false, true,  false, false FROM sem_telefone t
        UNION ALL SELECT g.cpf, 0::numeric, false, false, false, false, false, false, true,  false FROM sem_negociacao g
      ) AS u(cpf, saldo, tem_2026, e_nunca, e_sem_cont, e_repetido, e_recup, e_sem_tel, e_sem_neg, e_fonte)
     GROUP BY u.cpf
    HAVING bool_or(u.e_fonte)
  ),
  ja_coletados AS MATERIALIZED (
    SELECT DISTINCT c.cpf FROM public.prime_contratos c
     WHERE c.coletado_em > now() - interval '7 days'
  )
  SELECT c.cpf, c.saldo
    FROM candidatos c
   WHERE NOT EXISTS (SELECT 1 FROM ja_coletados j WHERE j.cpf = c.cpf)
     -- quem o Prime nao devolveu tambem sai por 7 dias -- mesma janela de quem
     -- foi coletado. Sem isto a fila volta neles a cada 2 minutos e trava.
     AND NOT EXISTS (SELECT 1 FROM public.prime_cadastro_sem_retorno sr
                      WHERE sr.cpf = c.cpf
                        AND sr.ultima_tentativa > now() - interval '7 days')
   ORDER BY c.e_nunca DESC,     -- 0) nunca coletado: nao sabemos nada dele
            c.e_sem_cont DESC,  -- 1) sem contato nenhum: inalcancavel
            c.e_repetido DESC,  -- 2) cadastro repetido
            c.e_sem_tel DESC,   -- 3) sem telefone
            c.tem_2026 DESC,
            c.e_sem_neg DESC,
            c.e_recup DESC,     -- 5) recuperados: destrava a medicao
            c.saldo DESC,
            c.cpf                -- desempate estavel: paginacao nao repete nem perde
   LIMIT greatest(1, least(coalesce(p_limite, 50), 500));
$function$;

revoke all on function public.prime_cadastro_pendentes(integer) from public, anon;
-- so o service_role, como ja era: quem chama e a Edge Function, nao a tela.
grant execute on function public.prime_cadastro_pendentes(integer) to service_role;
