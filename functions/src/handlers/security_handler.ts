/* eslint-disable max-len */
/* eslint-disable indent */
import {Request, Response} from "express"

/**
 * Serves the security.txt file as per RFC 9116
 * Provides security researchers with a standardized way to report vulnerabilities
 * Available at: /.well-known/security.txt
 * @param {*} req
 * @param {*} res
 */
export const serveSecurity = async (req: Request, res: Response) => {
  try {
    // RFC 9116 security.txt format
    // All dates are in RFC 3339 format
    const securityTxtContent = `Contact: mailto:security@deepscrape.dev
Contact: https://deepscrape.dev/security
Expires: 2027-05-28T00:00:00Z
Preferred-Languages: en
Policy: https://deepscrape.dev/security-policy
Acknowledgments: https://deepscrape.dev/security-acknowledgments
Canonical: https://deepscrape.dev/.well-known/security.txt
`

    // Serve as plaintext with appropriate headers
    res.setHeader("Content-Type", "text/plain; charset=utf-8")
    res.setHeader("Cache-Control", "public, max-age=604800") // Cache for 7 days
    res.status(200).send(securityTxtContent)
  } catch (error) {
    console.error("Error serving security.txt:", error)
    res.status(500).json({error: "Failed to serve security.txt"})
  }
}
