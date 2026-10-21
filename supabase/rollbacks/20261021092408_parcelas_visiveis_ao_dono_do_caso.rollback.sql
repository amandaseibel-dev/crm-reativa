-- ROLLBACK de 20261021092408_parcelas_visiveis_ao_dono_do_caso.sql
--
-- SO DDL, SO duas funcoes de LEITURA. Nenhuma tabela, nenhum gatilho, nenhum
-- dado -- nao ha dado a restaurar, porque a migration nao escreveu nada. Os
-- corpos abaixo sao os de producao em 20/10/2026, `pg_get_functiondef` palavra
-- por palavra:
--   public.parcelas_vencendo_2_dias    md5(prosrc) 662c264c4bf6385d023cc01fb43aebe5
--   public.acordo_alertas_do_operador  md5(prosrc) dff8a61dd1afe91f4f84304deec9eda9
--
-- ATENCAO: este rollback REINTRODUZ o defeito. Com ele:
--   * as duas filas voltam a enderecar pelo dono do ACORDO, e o responsavel
--     operacional volta a nao ver a parcela do caso que e dele -- 3.077 parcelas
--     vivas em que os dois donos diferem;
--   * as parcelas VENCIDAS voltam a nao aparecer em fila nenhuma (1.022 dentro
--     de 30 dias);
--   * `nao_acionar` e suspensao/juridico voltam a NAO ser filtrados nessas duas
--     leituras.
-- Nada precisa ser desagendado: o estado anterior e o de hoje.
--
-- NAO TOCADO por esta migration e portanto sem reversao:
--   parcela_viva, caso_encerrado_operacional, usuario_e_gestao,
--   usuario_e_gestao_fila, acordo_alertas_gerar, a tabela
--   acordo_alertas_parcela, `acordos` e a titularidade financeira.

CREATE OR REPLACE FUNCTION public.parcelas_vencendo_2_dias()
 RETURNS TABLE(aluno_nome text, aluno_id uuid, numero integer, valor numeric, vencimento date, operador_email text, operador_nome text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT a.nome, ac.aluno_id, p.numero, p.valor, p.vencimento, ac.operador_responsavel_email, ac.operador_responsavel_nome
  FROM public.parcelas p
  JOIN public.acordos ac ON ac.id = p.acordo_id
  JOIN public.alunos a ON a.id = ac.aluno_id
  WHERE public.parcela_viva(p.status)
    AND p.vencimento = current_date + interval '2 days'
    AND (
      public.usuario_e_gestao_fila()
      OR lower(ac.operador_responsavel_email) = lower(coalesce(auth.jwt()->>'email',''))
    )
  ORDER BY p.vencimento ASC;
$function$;

comment on function public.parcelas_vencendo_2_dias() is null;

CREATE OR REPLACE FUNCTION public.acordo_alertas_do_operador(p_aluno_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(aluno_id uuid, aluno_nome text, acordo_id uuid, numero_acordo integer, parcela_id uuid, numero_parcela integer, valor numeric, vencimento date, dias_restantes integer, data_alerta date, responsavel_email text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select x.aluno_id, al.nome::text, x.acordo_id, a.numero_acordo::int, x.parcela_id, x.numero_parcela::int, x.valor::numeric, x.vencimento,
         (x.vencimento - current_date)::int, x.data_alerta, x.responsavel_email
    from public.acordo_alertas_parcela x
    join public.acordos a on a.id = x.acordo_id
    left join public.alunos al on al.id = x.aluno_id
   where x.resolvido_em is null and x.tipo = 'D2'
     and (p_aluno_id is null or x.aluno_id = p_aluno_id)
     and (public.usuario_e_gestao() or lower(coalesce(x.responsavel_email,'')) = lower(coalesce(auth.jwt()->>'email','')))
   order by x.vencimento, al.nome;
$function$;

comment on function public.acordo_alertas_do_operador(uuid) is null;
