# Seguridad

## Nunca publiques tu API key

La API key (`sk_live_…`) da acceso a tu workspace de Sequentia. **No la pegues en issues, PRs, capturas ni logs.**

El CLI está hecho para ayudarte con eso: la enmascara en pantalla y **nunca** la incluye en los comandos que imprime. Si aun así se te filtró una, **rotala primero** y avisá después.

El `.env` está en el `.gitignore`. No lo agregues a la fuerza con `git add -f`.

## Reportar una vulnerabilidad

Si encontrás un problema de seguridad **en este CLI**, abrí un [security advisory privado](https://github.com/boostack-co/sequentia-test-cli/security/advisories/new) en vez de un issue público.

Si el problema es del **servicio Sequentia** y no de este cliente, reportalo por los canales de soporte de Sequentia: acá solo vive el cliente.

## Alcance

Esta herramienta habla con el servidor MCP de Sequentia usando tu credencial. No guarda nada más que la configuración que vos creás en `~/.config/sq-mcp/.env`, no envía telemetría, y no tiene dependencias de terceros — la superficie de ataque es el código de este repo y el runtime de Node.
