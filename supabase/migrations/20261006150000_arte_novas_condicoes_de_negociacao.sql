-- Arte nova: "Novas condicoes de negociacao".
--
-- Amanda, 06/10: mandou a arte da campanha e pediu para subir como e-mail dos
-- alunos, com o assunto "Condicoes de negociacao atualizadas para voce".
--
-- ASSUNTO. Exatamente o que ela pediu. Segue a mesma regra da arte de
-- 02/09: NAO cita divida, valor nem atraso -- a previa da caixa de entrada
-- aparece na tela do celular na frente de terceiros, e expor a inadimplencia
-- ali e o que o art. 42 do CDC nao perdoa. "Atualizadas para voce" da o
-- gatilho de abertura sem dizer do que se trata.
--
-- ORDEM 0. Fica na frente das demais enquanto a campanha estiver no ar: e o
-- primeiro chip da ficha do aluno e a arte que o Envio em lote ja abre
-- selecionada (src/pages/EnvioGmailLote.jsx usa tpls[0]).
--
-- CHAMADO PARA ACAO. A arte pede "responda este e-mail para verificar as
-- condicoes" -- entao o destaque do corpo e a resposta, nao um link de
-- pagamento. O WhatsApp (51) 99915-4925 e o numero impresso na arte, que e
-- diferente do usado nas outras artes (99274-1192); o telefone de ligacoes
-- segue o mesmo das demais.
--
-- JANELA. O texto diz "somente esta semana" porque a arte diz. E campanha com
-- prazo: quando ela encerrar, rodar o rollback ou `ativo = false` -- senao o
-- operador segue mandando urgencia vencida.
--
-- `novo = true` acende o pop-up do AvisoTemplateNovo; as artes antigas perdem
-- o `novo` para o aviso anunciar so esta.
--
-- Layout identico as demais: cabecalho com a logo, corpo com borda, caixa azul
-- no chamado, botoes de WhatsApp/telefone e rodape cinza. Assinatura
-- institucional, como na arte.
--
-- `email_templates` so existe em prod hoje, dai a guarda de tabela.

do $$
begin
  if to_regclass('public.email_templates') is null then
    return;
  end if;

  insert into public.email_templates
    (chave, situacao, ordem, assunto, corpo_html, corpo_texto, permite_anexo, ativo, dias_retorno, novo)
  values (
    'novas_condicoes_negociacao',
    'Novas condições de negociação',
    0,
    'Condições de negociação atualizadas para você',
    '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a"><div style="background:#ffffff;padding:22px 20px;border:1px solid #e5e7eb;border-bottom:none;border-radius:12px 12px 0 0;text-align:center"><img src="https://crm-reativa.vercel.app/logo_padrao_email.png" alt="ReATIVA" width="200" style="display:inline-block;width:200px;max-width:200px;height:auto;border:0;outline:none;text-decoration:none"></div><div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:20px;line-height:1.5"><div style="background:#1e3a8a;border-radius:10px;padding:16px 18px;text-align:center;color:#ffffff"><div style="font-size:20px;font-weight:800;letter-spacing:0.3px">NOVAS CONDIÇÕES DE NEGOCIAÇÃO</div><div style="margin-top:6px;font-size:14px;color:#dbeafe">disponíveis somente <strong style="color:#facc15">esta semana</strong></div></div><p style="margin-top:18px">Olá, <strong>{{nome}}</strong>!</p><p>Seu contrato junto à ULBRA entrou em uma rodada de condições atualizadas, válida por tempo limitado.</p><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:14px 0;border-collapse:collapse"><tr><td style="padding:10px 0;border-bottom:1px solid #eef2f6"><strong>Consulte as opções</strong><br><span style="color:#475569">disponíveis para o seu caso.</span></td></tr><tr><td style="padding:10px 0;border-bottom:1px solid #eef2f6"><strong>Atendimento oficial</strong><br><span style="color:#475569">em parceria com a ULBRA.</span></td></tr><tr><td style="padding:10px 0"><strong>Mais oportunidades</strong><br><span style="color:#475569">para regularizar sua situação.</span></td></tr></table><p style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px;text-align:center;font-weight:700">✉️ Responda este e-mail para verificar as condições disponíveis para você.</p><p style="color:#64748b;font-size:13px">Caso o pagamento já tenha sido realizado, por favor, desconsidere esta mensagem.</p><div style="margin-top:18px;padding-top:14px;border-top:1px solid #eef2f6"><a href="https://wa.me/5551999154925" style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;padding:9px 14px;border-radius:8px;font-weight:700">💬 WhatsApp (51) 99915-4925</a> <a href="tel:+555134779218" style="display:inline-block;margin-left:8px;background:#1e40af;color:#fff;text-decoration:none;padding:9px 14px;border-radius:8px;font-weight:700">📞 Ligações (51) 3477-9218</a></div><p style="color:#64748b;font-size:13px;margin-top:14px">Atendimento seguro e oficial em parceria com a ULBRA.<br>Atenciosamente,<br><strong>Equipe ReATIVA</strong> — Atendimento ULBRA</p></div></div>',
    'NOVAS CONDIÇÕES DE NEGOCIAÇÃO — disponíveis somente esta semana

Olá, {{nome}}!

Seu contrato junto à ULBRA entrou em uma rodada de condições atualizadas, válida por tempo limitado.

- Consulte as opções disponíveis para o seu caso.
- Atendimento oficial em parceria com a ULBRA.
- Mais oportunidades para regularizar sua situação.

Responda este e-mail para verificar as condições disponíveis para você.

Prefere falar agora? WhatsApp (51) 99915-4925 (abrir: https://wa.me/5551999154925) ou Ligações (51) 3477-9218.

Caso o pagamento já tenha sido realizado, por favor, desconsidere esta mensagem.

Atendimento seguro e oficial em parceria com a ULBRA.
Atenciosamente,
Equipe ReATIVA — Atendimento ULBRA',
    false,
    true,
    2,
    true
  )
  on conflict (chave) do update set
    situacao      = excluded.situacao,
    ordem         = excluded.ordem,
    assunto       = excluded.assunto,
    corpo_html    = excluded.corpo_html,
    corpo_texto   = excluded.corpo_texto,
    permite_anexo = excluded.permite_anexo,
    ativo         = excluded.ativo,
    dias_retorno  = excluded.dias_retorno,
    novo          = excluded.novo;

  -- o pop-up anuncia so a arte da campanha
  update public.email_templates
     set novo = false
   where chave <> 'novas_condicoes_negociacao'
     and novo is true;
end $$;
