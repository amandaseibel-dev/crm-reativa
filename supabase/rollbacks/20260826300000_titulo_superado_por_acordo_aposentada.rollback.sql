-- Rollback: devolve a dedução por data.
--
-- ATENÇÃO: isso volta a esconder R$ 6.229.309,16 de mensalidade em aberto de
-- 1.432 alunos, com base num palpite de calendário. A gestão foi explícita em
-- 26/08/2026: "não crie regras que não existem". Não reative sem ordem direta.
create or replace function public.titulo_superado_por_acordo(p_aluno_id uuid, p_vencimento date)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select exists (
    select 1 from public.acordos a
     where a.aluno_id = p_aluno_id
       and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
       and a.criado_em::date > p_vencimento
       and exists (select 1 from public.parcelas p where p.acordo_id = a.id and coalesce(p.valor,0) > 0)
  );
$function$;
