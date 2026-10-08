-- ROLLBACK de 20261008103000_suspensao_fora_do_saldo_cobravel.
--
-- Restaura `saldo_cobravel_aluno` ao corpo de PRODUCAO de 08/10/2026, de antes
-- do portao de suspensao.
--
-- NAO HA DADO A REVERTER: a migration nao escreveu em nenhuma linha. A exclusao
-- era DERIVADA do estado do aluno, nao gravada no titulo -- e e por isso que o
-- rollback dela e so trocar o corpo de uma funcao.
--
-- DEPENDENCIA: este arquivo devolve a lista literal de status em vez de chamar
-- `parcela_viva()`, para que ele funcione mesmo que o rollback da fundacao
-- (20261007210000) tenha rodado antes. A lista aqui e a que a funcao tinha em
-- producao: ela SEMPRE excluiu RENEGOCIADA.
--
-- CONSEQUENCIA DE EXECUTAR: os R$ 462.909,38 de 186 titulos de 118 alunos com
-- cobranca suspensa VOLTAM a contar como saldo cobravel.

create or replace function public.saldo_cobravel_aluno(p_aluno_id uuid)
returns numeric
language sql
stable security definer
set search_path to 'public'
as $function$
  SELECT round(
    coalesce((
      SELECT sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_original, 0))
        FROM public.acordos_titulos t
       WHERE t.aluno_id = p_aluno_id
         AND upper(coalesce(t.situacao,'')) IN ('ABERTO','NEGOCIADO')
         AND coalesce(lower(t.status),'') <> 'quitada'
         AND coalesce(t.tipo_boleto,'') <> 'Acordo'
         AND NOT EXISTS (
           SELECT 1 FROM public.acordo_titulo_vinculo v
             JOIN public.acordos a ON a.id = v.acordo_id
            WHERE v.titulo_id = t.id AND coalesce(v.ativo, true)
              AND upper(coalesce(a.status,'')) NOT IN ('CANCELADO','CANCELADA'))
    ), 0)
    + coalesce((
      SELECT sum(coalesce(p.valor,0))
        FROM public.parcelas p
        JOIN public.acordos a ON a.id = p.acordo_id
       WHERE a.aluno_id = p_aluno_id
         AND upper(coalesce(a.status,'')) = 'ATIVO'
         AND upper(coalesce(p.status,'')) NOT IN
             ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO','RENEGOCIADA')
    ), 0)
  , 2);
$function$;

comment on function public.saldo_cobravel_aluno(uuid) is
  'Saldo cobravel do aluno (titulos abertos nao negociados + parcelas vivas de acordo ATIVO).';
